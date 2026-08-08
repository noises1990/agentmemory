import { describe, it, expect, vi } from "vitest";
import {
  createShutdownHandler,
  resolveShutdownTimeouts,
  DEFAULT_SHUTDOWN_DEADLINE_MS,
  DEFAULT_CLOSE_VIEWER_MS,
  DEFAULT_SAVE_INDEX_MS,
  DEFAULT_DISCONNECT_ENGINE_MS,
  type ShutdownDeps,
  type ShutdownLogger,
} from "../src/shutdown.js";

/**
 * The bug these guard against: under `systemctl stop` with
 * KillMode=control-group the iii-engine dies alongside us, so
 * `indexPersistence.save()` -- which writes over the engine WS -- never
 * settles, and the drain hung there until systemd SIGKILLed it mid-write.
 *
 * Every case below is "a dependency never settles", which is exactly what a
 * real engine cannot be talked into on demand -- hence the injected deps.
 * Timeouts are overridden down to milliseconds so the suite stays fast.
 */

/** A promise that is never going to settle. Stands in for the dead engine. */
const wedged = () => new Promise<never>(() => {});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeLogger(): ShutdownLogger & {
  log: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/**
 * Wire a handler over fakes. Every dependency resolves immediately unless the
 * test replaces it, so each case states only the thing it is actually about.
 */
function makeHarness(overrides: Partial<ShutdownDeps> = {}) {
  const order: string[] = [];
  const logger = makeLogger();
  const exit = vi.fn<(code: number) => void>();

  const viewerServer = {
    close: vi.fn((cb?: (err?: Error) => void) => {
      order.push("close");
      cb?.();
      return undefined;
    }),
    closeAllConnections: vi.fn(() => {
      order.push("closeAllConnections");
    }),
  };
  const indexPersistence = {
    save: vi.fn(async () => {
      order.push("save");
    }),
  };
  const sdk = {
    shutdown: vi.fn(async () => {
      order.push("sdkShutdown");
    }),
  };
  const stopTimers = vi.fn(() => order.push("stopTimers"));
  const clearPidfile = vi.fn(() => order.push("clearPidfile"));

  const deps: ShutdownDeps = {
    viewerServer,
    sdk,
    indexPersistence,
    stopTimers,
    clearPidfile,
    logger,
    exit,
    timeouts: {
      deadlineMs: 200,
      closeViewerMs: 20,
      saveIndexMs: 20,
      disconnectEngineMs: 20,
    },
    ...overrides,
  };

  // Read the deps back off the merged object, not the locals above, so an
  // overridden fake is the one the assertions actually see.
  return {
    handler: createShutdownHandler(deps),
    order,
    logger,
    exit,
    viewerServer: deps.viewerServer,
    indexPersistence: deps.indexPersistence,
    sdk: deps.sdk,
    stopTimers: deps.stopTimers,
    clearPidfile: deps.clearPidfile,
  };
}

describe("createShutdownHandler", () => {
  it("drains in order and exits 0 without the hard deadline firing", async () => {
    // Deadline shorter than the wait below, so if it were ever left armed the
    // assertion at the end would catch it rather than the test just passing.
    const h = makeHarness({
      timeouts: {
        deadlineMs: 30,
        closeViewerMs: 20,
        saveIndexMs: 20,
        disconnectEngineMs: 20,
      },
    });

    const started = Date.now();
    await h.handler("SIGTERM");
    const elapsed = Date.now() - started;

    // Nothing waited on a timeout -- the drain moved at the speed of its deps.
    expect(elapsed).toBeLessThan(20);

    // The index flush must land before sdk.shutdown() tears down the WS it
    // travels over, and serving must stop before either.
    expect(h.order).toEqual([
      "stopTimers",
      "close",
      "closeAllConnections",
      "save",
      "sdkShutdown",
      "clearPidfile",
    ]);
    expect(h.exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(h.logger.warn).not.toHaveBeenCalled();
    expect(h.logger.error).not.toHaveBeenCalled();

    // Past the deadline: clearTimeout really happened, so nothing forces a
    // non-zero exit out from under a drain that already finished.
    await sleep(60);
    expect(h.exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(h.logger.error).not.toHaveBeenCalled();
  });

  it("cuts off a wedged index save and still exits 0 (dead engine)", async () => {
    // The engine is gone, so the save never settles -- the original hang.
    const h = makeHarness({
      indexPersistence: { save: vi.fn(wedged) },
    });

    await h.handler("SIGTERM");

    expect(h.logger.warn).toHaveBeenCalledWith(
      '[agentmemory] Shutdown step "save index" timed out after 20ms; continuing.',
    );
    // The step after the wedged one still ran: one stuck peer does not starve
    // the rest of the drain.
    expect(h.sdk.shutdown).toHaveBeenCalledOnce();
    expect(h.clearPidfile).toHaveBeenCalledOnce();
    expect(h.exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(h.logger.error).not.toHaveBeenCalled();
  });

  it("cuts off a wedged engine disconnect and still exits 0", async () => {
    const h = makeHarness({ sdk: { shutdown: vi.fn(wedged) } });

    await h.handler("SIGTERM");

    expect(h.logger.warn).toHaveBeenCalledWith(
      '[agentmemory] Shutdown step "disconnect engine" timed out after 20ms; continuing.',
    );
    expect(h.indexPersistence.save).toHaveBeenCalledOnce();
    expect(h.exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("forces a non-zero exit when the whole drain wedges", async () => {
    // Per-step budgets far past the deadline, so no step can rescue the drain
    // and the hard deadline is the only thing left that can fire.
    //
    // Note what this does NOT cover: that the deadline timer is not unref'd.
    // Under vitest the process is kept alive by the runner, so an unref'd
    // timer fires here just the same -- the property only bites in a process
    // whose last remaining handle is that timer, which needs a real
    // subprocess to observe. Keep the `setTimeout` un-unref'd on sight.
    const h = makeHarness({
      viewerServer: { close: vi.fn(wedged) },
      indexPersistence: { save: vi.fn(wedged) },
      sdk: { shutdown: vi.fn(wedged) },
      timeouts: {
        deadlineMs: 30,
        closeViewerMs: 60_000,
        saveIndexMs: 60_000,
        disconnectEngineMs: 60_000,
      },
    });

    // Deliberately not awaited: this drain never returns, which is the point.
    void h.handler("SIGTERM");
    await sleep(120);

    expect(h.logger.error).toHaveBeenCalledWith(
      "[agentmemory] Shutdown exceeded 30ms; forcing exit.",
    );
    expect(h.exit).toHaveBeenCalledExactlyOnceWith(1);
    // Never reached the tail of the drain, so it must not have claimed success.
    expect(h.exit).not.toHaveBeenCalledWith(0);
    expect(h.clearPidfile).not.toHaveBeenCalled();
  });

  it("ignores a second signal while already draining", async () => {
    // KillMode=control-group delivers the signal to every process in the unit,
    // and the handler used to re-enter and race itself through the drain.
    // A save slow enough that the second signal lands mid-drain, but well
    // inside its budget -- this case is about re-entry, not about timeouts.
    const h = makeHarness({
      indexPersistence: {
        save: vi.fn(async () => {
          await sleep(40);
        }),
      },
      timeouts: {
        deadlineMs: 500,
        closeViewerMs: 100,
        saveIndexMs: 200,
        disconnectEngineMs: 100,
      },
    });

    const first = h.handler("SIGTERM");
    const second = h.handler("SIGINT"); // lands mid-drain
    await Promise.all([first, second]);

    expect(h.stopTimers).toHaveBeenCalledOnce();
    expect(h.indexPersistence.save).toHaveBeenCalledOnce();
    expect(h.sdk.shutdown).toHaveBeenCalledOnce();
    expect(h.clearPidfile).toHaveBeenCalledOnce();
    expect(h.exit).toHaveBeenCalledExactlyOnceWith(0);
    // One announcement, not the doubled "Shutting down..." from the logs.
    expect(h.logger.log).toHaveBeenCalledExactlyOnceWith(
      "\n[agentmemory] Shutting down (SIGTERM)...",
    );

    // And still a no-op once the drain is over.
    await h.handler("SIGTERM");
    expect(h.exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("keeps draining when a step rejects instead of hanging", async () => {
    const h = makeHarness({
      indexPersistence: {
        save: vi.fn(async () => {
          throw new Error("engine gone");
        }),
      },
    });

    await h.handler("SIGTERM");

    expect(h.logger.warn).toHaveBeenCalledWith(
      '[agentmemory] Shutdown step "save index" failed:',
      expect.any(Error),
    );
    expect(h.sdk.shutdown).toHaveBeenCalledOnce();
    expect(h.exit).toHaveBeenCalledExactlyOnceWith(0);
  });
});

describe("resolveShutdownTimeouts", () => {
  it("defaults to the values main() shipped with", () => {
    expect(resolveShutdownTimeouts()).toEqual({
      deadlineMs: DEFAULT_SHUTDOWN_DEADLINE_MS,
      closeViewerMs: DEFAULT_CLOSE_VIEWER_MS,
      saveIndexMs: DEFAULT_SAVE_INDEX_MS,
      disconnectEngineMs: DEFAULT_DISCONNECT_ENGINE_MS,
    });
    // The per-step budgets stay under the ceiling, so the normal degraded case
    // finishes on its own and the deadline is only ever a backstop.
    expect(
      DEFAULT_CLOSE_VIEWER_MS + DEFAULT_SAVE_INDEX_MS + DEFAULT_DISCONNECT_ENGINE_MS,
    ).toBeLessThan(DEFAULT_SHUTDOWN_DEADLINE_MS);
  });

  it("honours AGENTMEMORY_SHUTDOWN_DEADLINE_MS", () => {
    const prev = process.env["AGENTMEMORY_SHUTDOWN_DEADLINE_MS"];
    process.env["AGENTMEMORY_SHUTDOWN_DEADLINE_MS"] = "1234";
    try {
      expect(resolveShutdownTimeouts().deadlineMs).toBe(1234);
      // An explicit override still wins over the environment.
      expect(resolveShutdownTimeouts({ deadlineMs: 7 }).deadlineMs).toBe(7);
    } finally {
      if (prev === undefined) delete process.env["AGENTMEMORY_SHUTDOWN_DEADLINE_MS"];
      else process.env["AGENTMEMORY_SHUTDOWN_DEADLINE_MS"] = prev;
    }
  });
});
