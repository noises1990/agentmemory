# Windows helper scripts

Optional helpers for running agentmemory natively on Windows: keep API
tokens out of `.env`, start the daemon with those tokens injected, and
start it again at logon.

Nothing here is required. `agentmemory` works on Windows with a plain
`~/.agentmemory/.env`; these scripts exist for setups that would rather
not have a secret sitting in a file.

| Script | Purpose |
| --- | --- |
| `credstore.ps1` | Store/read/delete secrets in Windows Credential Manager |
| `start-agentmemory.ps1` | Start the daemon with those secrets injected into its environment |
| `register-autostart.ps1` | Register a per-user Scheduled Task so the daemon starts at logon |
| `start-tunnel.ps1` | Publish the daemon as `https://mem.inspekter.app` over a Cloudflare Tunnel, token injected the same way |
| `register-tunnel-autostart.ps1` | Per-user Scheduled Task so the tunnel comes up after the daemon at logon |
| `watchdog.ps1` | Every few minutes: restart the daemon only if `:3111` is silent; start the tunnel if its `/ready` is not 200 |
| `register-watchdog.ps1` | Per-user task for `watchdog.ps1` -- 5-minute repetition plus a logon trigger |

They build on each other in that order: the launcher calls `credstore.ps1`,
and the task registration calls the launcher. Keep them in the same
directory — each resolves its dependency as a sibling.

## Setup

```powershell
# 1. Store the token. Prompts with a masked field; the value is never
#    echoed and never passed as an argument (which would put it in shell
#    history and in the process command line, readable by any process).
.\credstore.ps1 -Set -Name agentmemory/CLOUDFLARE_API_TOKEN

# 2. Start the daemon.
.\start-agentmemory.ps1

# 3. Optional: start it automatically at logon.
.\register-autostart.ps1
```

Your `~/.agentmemory/.env` then holds only non-secret configuration —
endpoints, model names, feature flags — and is safe to read, diff, and
back up.

To wire a different provider, add a line to the `$SECRETS` map in
`start-agentmemory.ps1` mapping a credential name to the environment
variable agentmemory reads. Missing entries warn rather than abort, so
the daemon can still start in a reduced mode.

## Why a logon task and not a Windows service

The credential vault is encrypted at rest by DPAPI under your user
account, so decryption needs your interactive logon session. A service
running as `SYSTEM` — or a task set to "run whether user is logged on or
not" — cannot read it. The daemon would start with no provider and
silently degrade to zero-LLM rather than failing loudly, which is a much
worse outcome than not starting.

So the task runs as the current user with `LogonType Interactive` and
`RunLevel Limited`. No elevation is required to register it, and no
password is stored anywhere.

## Notes

- The task runs Windows PowerShell 5.1 (`System32\WindowsPowerShell`)
  rather than `pwsh`, so it keeps working if PowerShell 7 is moved or
  uninstalled. All three scripts are ASCII-only and parse under both.
  (5.1 reads `.ps1` files as ANSI when there is no BOM, so a stray
  non-ASCII character in a comment is a parse error there but not in 7.)
- `start-agentmemory.ps1 -Stop` sweeps orphaned workers by command line,
  not just by pidfile. `agentmemory stop` tracks a single `worker.pid`,
  but the engine spawns workers via `iii-exec`, so one started by a
  previous engine can outlive the pidfile and keep holding the REST port
  — which surfaces as "address already in use" with no obvious cause.
- Ports derive from `III_REST_PORT` (default 3111), matching `config.ts`:
  REST, REST+1 streams, REST+2 viewer, REST+46023 engine.

## Publishing the daemon to the estate

The workspace gatekeeper reaches the daemon at `https://mem.inspekter.app`, a
Cloudflare Access-protected hostname that fronts a `cloudflared` tunnel. Since
2026-09-05 that tunnel runs on this machine (`workhorse-agentmemory`, remotely
managed -- its ingress `mem.inspekter.app -> http://127.0.0.1:3111` lives in the
Cloudflare dashboard, not in a local `config.yml`).

```powershell
# 1. Install cloudflared once (official package, no download step in the scripts).
winget install --id Cloudflare.cloudflared -e

# 2. Store the tunnel token. Same rule as the API token: masked prompt,
#    never an argument, never a file.
.\credstore.ps1 -Set -Name agentmemory/TUNNEL_TOKEN

# 3. Start the tunnel. Ready means cloudflared's own /ready answers 200,
#    which it does only while it holds a live connection to Cloudflare.
.\start-tunnel.ps1

# 4. Optional: at logon, 75s after logon so the daemon (45s) is listening first.
.egister-tunnel-autostart.ps1
```

The token reaches `cloudflared` only through the child process's `TUNNEL_TOKEN`
environment variable and is cleared from the launcher the moment the child exists.
Logs go to `~/.agentmemory/tunnel.err.log` (cloudflared logs to stderr).

While this machine is asleep or logged out, the estate has no memory upstream --
the gatekeeper answers `502 upstream-error`, loudly. That is the accepted trade of
hosting it on a workstation, until memory moves to a Cloudflare-native store.

## Keeping it up

A process that exists is not a service that works; only the port is. On 2026-09-05 the
daemon's `node` and `iii` processes were alive while nothing answered on `:3111`, and the
tunnel published that dead origin to the whole estate as 502 for hours. So:

```powershell
.\start-agentmemory.ps1 -IfDown   # restart ONLY when :3111 gives no HTTP answer at all
.egister-watchdog.ps1           # run watchdog.ps1 every 5 min and 45s after logon
.egister-watchdog.ps1 -Status
```

Any HTTP status from our own `127.0.0.1:3111` -- a 401 included -- counts as alive; a
wedged daemon is the only thing `-IfDown` restarts. The tunnel launcher is already
idempotent. Actions, and only actions, are appended to `~/.agentmemory/watchdog.log`.

The watchdog supersedes the plain logon task for the daemon: a task registered under
another security context cannot be enabled or replaced from a normal shell, and one such
was found sitting disabled since 2026-08-03.

## Checking and removing

```powershell
.\register-autostart.ps1 -Status      # state and last exit code
.\register-autostart.ps1 -Unregister  # remove the task
```

`Last result` of `0` means the last run succeeded; `267011` means the
task has not run yet. Startup output goes to `~/.agentmemory/daemon.log`
and `daemon.err.log`.
