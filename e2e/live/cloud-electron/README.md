# Live cloud-workspace validation (Electron over CDP)

Drives the **real desktop app** against the **real three-node stack**, and checks
the things no mocked test can see: that cloud mode reaches a different machine's
data, that every renderer request goes through the loopback proxy, that
better-auth resolves a session against the proxy prefix, that the preference
survives a restart, and that windows caching a base URL are torn down when it
changes.

This found a P1 that 8,255 unit tests and every E2E suite missed — cloud mode was
completely unusable, because better-auth silently declines to append `/api/auth`
to a base URL that already has a path. See `docs/cloud-workspace.md`.

## Running it

1. Stand up the stack — the runbook is
   [`.claude/skills/electron-cloud-interface-validation/SKILL.md`](../../../.claude/skills/electron-cloud-interface-validation/SKILL.md).
   All three nodes must answer: auth on 3002, proxy on 8787, deployment on 8899.
2. Build the app and its native modules **for Electron**:

   ```bash
   npx electron-rebuild -f      # better-sqlite3 for the Electron ABI
   npx electron-vite build      # the harness runs dist/, not the dev server
   ```

3. Run:

   ```bash
   node e2e/live/cloud-electron/run.mjs
   ```

Afterwards, `npm rebuild better-sqlite3` puts the native module back on the Node
ABI — vitest and the Playwright suites need that, and the failure if you forget
is an `ERR_DLOPEN_FAILED` at startup rather than anything that names the cause.

Expect **28 checks passed**. When one fails it prints what was on screen at the
time; for anything deeper, `node e2e/live/cloud-electron/inspect.mjs` replays a
switch with every request, response, page error and navigation logged.

## Layout

| File | What it is |
| --- | --- |
| `stack.mjs` | Where the three nodes live; every value overridable from the environment |
| `harness.mjs` | Launching Electron with a debugging port, seeding its data dir, attaching over CDP |
| `run.mjs` | The 28 checks, in six groups |
| `inspect.mjs` | A switch, narrated — for when a check fails and you need to know why |

## Two things the harness must keep doing

**Pin the container runner.** The seeded `settings.json` sets
`container.containerRunner` to `docker`, and that is not cosmetic.
`shutdownActiveRunner()` runs on every quit and calls the configured runner's
shutdown hook *without* consulting `E2E_MOCK`, and `getLimaHome()` is
`~/.superagent/lima` — shared with the installed build, not scoped to the data
dir. Left at the macOS default (`lima`), closing the harness force-stops the VM
the developer's own Gamut is running on. `docker` has no shutdown hook.

**Disable the single-instance lock.** The lock identity derives from `app.name`,
which the installed build shares, so without
`SUPERAGENT_DISABLE_SINGLE_INSTANCE=1` the harness process calls `app.exit(0)`
the moment Gamut is open — and a silent exit is indistinguishable from a hang.

## State that outlives a run

The local data dir is wiped per run. **The deployment is not**: it keeps its
user, that user's onboarding flag, and any agents created. So the suite arranges
its own preconditions rather than assuming a virgin deployment — it forces the
onboarding flag off before checking that the wizard appears, names its agents
uniquely per run, and deletes the ones earlier runs left behind.
