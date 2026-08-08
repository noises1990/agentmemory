/**
 * Bounded shutdown drain for the worker process.
 *
 * Every step here talks to a peer that may already be gone. Under
 * `systemctl stop` with KillMode=control-group, systemd signals every process
 * in the unit at once, so the iii-engine is being torn down at the same
 * moment we are trying to flush through it -- and `indexPersistence.save()`
 * writes over the engine WS, so it simply never settles. The drain used to
 * hang there until systemd's TimeoutStopSec ran out and SIGKILLed us mid-write.
 *
 * So: bound each step individually, keep a hard ceiling over the whole thing,
 * and refuse to run twice.
 *
 * Lives apart from `main()` so it can be constructed against fakes: the
 * interesting cases are all "a dependency never settles", which is not
 * something a real engine, socket, or index can be talked into on demand.
 */

/** The slice of `http.Server` the drain touches. */
export interface ClosableServer {
  close(cb?: (err?: Error) => void): unknown;
  closeAllConnections?: () => void;
}

/** The slice of `IndexPersistence` the drain touches. */
export interface IndexPersistenceHandle {
  save(): Promise<unknown>;
}

/** The slice of the iii-sdk worker handle the drain touches. */
export interface EngineHandle {
  shutdown(): Promise<unknown>;
}

/** `console`, narrowed to what the drain uses. */
export interface ShutdownLogger {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

/**
 * Per-step budgets plus the ceiling over all of them.
 *
 * The per-step values sum to 9s, deliberately under the 10s deadline: in the
 * normal degraded case every step times out on its own and the drain still
 * finishes by itself, leaving the deadline as a backstop for a step that
 * wedges in a way its own timer cannot cut off.
 */
export interface ShutdownTimeouts {
  /** Ceiling on the whole drain, after which we exit non-zero. */
  deadlineMs: number;
  /** Budget for closing the viewer server and its sockets. */
  closeViewerMs: number;
  /** Budget for the final index flush. */
  saveIndexMs: number;
  /** Budget for `sdk.shutdown()`, which awaits an OTel flush over the WS. */
  disconnectEngineMs: number;
}

export const DEFAULT_SHUTDOWN_DEADLINE_MS = 10000;
export const DEFAULT_CLOSE_VIEWER_MS = 2000;
export const DEFAULT_SAVE_INDEX_MS = 4000;
export const DEFAULT_DISCONNECT_ENGINE_MS = 3000;

/**
 * Fill in the defaults, letting the operator move the ceiling via
 * AGENTMEMORY_SHUTDOWN_DEADLINE_MS and letting tests override everything.
 */
export function resolveShutdownTimeouts(
  overrides?: Partial<ShutdownTimeouts>,
): ShutdownTimeouts {
  return {
    deadlineMs:
      overrides?.deadlineMs ??
      parseInt(
        process.env["AGENTMEMORY_SHUTDOWN_DEADLINE_MS"] ||
          String(DEFAULT_SHUTDOWN_DEADLINE_MS),
        10,
      ),
    closeViewerMs: overrides?.closeViewerMs ?? DEFAULT_CLOSE_VIEWER_MS,
    saveIndexMs: overrides?.saveIndexMs ?? DEFAULT_SAVE_INDEX_MS,
    disconnectEngineMs:
      overrides?.disconnectEngineMs ?? DEFAULT_DISCONNECT_ENGINE_MS,
  };
}

export interface ShutdownDeps {
  /** The only http.Server `main()` owns; REST and streams belong to the sdk. */
  viewerServer: ClosableServer;
  sdk: EngineHandle;
  indexPersistence: IndexPersistenceHandle;
  /**
   * Halt the recurring work before draining, so nothing schedules new writes
   * behind us. Passed as one callback because the order among those timers is
   * the caller's business, not ours.
   */
  stopTimers: () => void;
  /** Remove the worker pidfile once the drain is done. */
  clearPidfile: () => void;
  logger?: ShutdownLogger;
  /** Defaults to `process.exit`. Injected so tests can survive being "exited". */
  exit?: (code: number) => void;
  timeouts?: Partial<ShutdownTimeouts>;
}

/**
 * Build the signal handler. Register the result on both SIGINT and SIGTERM --
 * the returned closure carries the re-entry guard, so sharing one instance
 * across both signals is what makes the guard work.
 */
export function createShutdownHandler(
  deps: ShutdownDeps,
): (signal: NodeJS.Signals) => Promise<void> {
  const timeouts = resolveShutdownTimeouts(deps.timeouts);
  const log: ShutdownLogger = deps.logger ?? console;
  const exit = deps.exit ?? ((code: number) => process.exit(code));

  // Bound one step. A step that overruns logs and yields rather than throwing,
  // so a single stuck peer cannot starve the steps behind it.
  const step = async (
    label: string,
    ms: number,
    work: () => Promise<unknown>,
  ): Promise<void> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        work(),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            log.warn(
              `[agentmemory] Shutdown step "${label}" timed out after ${ms}ms; continuing.`,
            );
            resolve();
          }, ms);
          timer.unref();
        }),
      ]);
    } catch (err) {
      log.warn(`[agentmemory] Shutdown step "${label}" failed:`, err);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  // `server.close()` only resolves once every existing connection ends, so a
  // single keep-alive client (the viewer, a health poller) holds it open
  // forever. Closing the sockets explicitly is what makes the callback fire.
  const closeViewer = (): Promise<void> =>
    new Promise<void>((resolve) => {
      deps.viewerServer.close(() => resolve());
      deps.viewerServer.closeAllConnections?.();
    });

  let shuttingDown = false;

  return async (signal: NodeJS.Signals): Promise<void> => {
    // KillMode=control-group delivers the signal to every process in the unit,
    // and the handler was re-entering -- logging "Shutting down..." twice and
    // racing itself through the drain.
    if (shuttingDown) return;
    shuttingDown = true;
    log.log(`\n[agentmemory] Shutting down (${signal})...`);

    // Deliberately not unref'd: if the drain wedges, this timer is what is
    // left holding the loop open, and it must still be able to fire.
    const hardExit = setTimeout(() => {
      log.error(
        `[agentmemory] Shutdown exceeded ${timeouts.deadlineMs}ms; forcing exit.`,
      );
      exit(1);
    }, timeouts.deadlineMs);

    deps.stopTimers();

    // Stop serving first so nothing new arrives mid-drain.
    await step("close viewer server", timeouts.closeViewerMs, closeViewer);

    // Before the engine link goes away: index writes travel over that same
    // WS, so flushing after sdk.shutdown() would silently lose them.
    await step("save index", timeouts.saveIndexMs, () =>
      deps.indexPersistence.save(),
    );

    // Last, and bounded: sdk.shutdown() awaits an OpenTelemetry flush across
    // the engine WS. Under `systemctl stop` the engine is being torn down at
    // the same moment, so that flush can never land -- it just retries against
    // a refused socket until something kills us.
    await step("disconnect engine", timeouts.disconnectEngineMs, () =>
      deps.sdk.shutdown(),
    );

    deps.clearPidfile();
    clearTimeout(hardExit);
    exit(0);
  };
}
