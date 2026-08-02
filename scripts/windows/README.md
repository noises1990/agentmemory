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

## Checking and removing

```powershell
.\register-autostart.ps1 -Status      # state and last exit code
.\register-autostart.ps1 -Unregister  # remove the task
```

`Last result` of `0` means the last run succeeded; `267011` means the
task has not run yet. Startup output goes to `~/.agentmemory/daemon.log`
and `daemon.err.log`.
