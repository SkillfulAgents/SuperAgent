# AGENTS.md

Repo-specific agent guidance. General coding/testing conventions live in [CLAUDE.md](CLAUDE.md); dev commands live in [README.md](README.md) and `package.json` scripts. Read those first.

## Cursor Cloud specific instructions

SuperAgent (product name "Gamut") is a single product with two build targets (web + Electron) plus a bundled `agent-container/` sub-package. The startup update script already runs `npm install` (root and `agent-container/`) and `npx playwright install chromium`.

### Running the app here

- This VM has no container runtime (Docker/Podman) and no `ANTHROPIC_API_KEY`. Real agents cannot execute, so `npm run dev` boots the full app but any agent chat fails at container spawn / LLM call.
- To exercise the full create-agent -> chat -> streamed-response flow without those, run mock mode: `E2E_MOCK=true npm run dev:web`. It swaps in `MockContainerClient` (reports Docker available, returns canned replies like "This is a mock response from the E2E test container."). This is the same harness the E2E suite uses. Set `E2E_CHROMIUM_PATH` to Playwright's chromium if you need the mock browser scenario.
- Use a throwaway data dir for mock/test runs to avoid polluting `~/.superagent`, e.g. `SUPERAGENT_DATA_DIR=/tmp/mock-data E2E_MOCK=true PORT=3000 npm run dev:web`.
- Real dev port is 47891 (`dev:electron` uses 5000). The README "Architecture" section's 3000/3001 ports are stale.

### Onboarding gate (non-obvious)

A getting-started wizard blocks the whole UI on first run. It is gated by the user-level `setupCompleted` flag, not global settings. To reach the dashboard headlessly, `PUT /api/user-settings` with `{"setupCompleted":true,"onboardingProgress":null}` (the running server must be hit), or seed `settings.json` with `app.setupCompleted:true` before boot the way `e2e/setup-e2e-data.js` does.

### Database

SQLite at `$SUPERAGENT_DATA_DIR/superagent.db` (default `~/.superagent`); no DB server. Run `npm run db:migrate` once against a fresh data dir before starting the plain dev server. `drizzle.config.ts` derives the path from `SUPERAGENT_DATA_DIR` / `SUPERAGENT_DB_PATH`.

### Tests

- Unit: `npm run test:run` (Vitest, root). Container: `npm run test:container`.
- E2E: `npm run test:e2e` auto-starts its own mock web server (no manual server needed) and requires the Playwright chromium browser. Per CLAUDE.md, tee output to a file. E2E runs with `retries: 0` locally, so occasional parallel-load flakes (e.g. send-button timeout) can appear - re-run the specific spec to confirm before treating it as a real failure.
- If the E2E chromium fails to launch on a fresh VM for missing system libraries, run `npx playwright install-deps chromium` once (needs sudo/apt; kept out of the update script).
