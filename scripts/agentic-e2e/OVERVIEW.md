# Agentic E2E Testing

Uses Claude as the test agent. It reads natural-language feature specs, drives the browser via Playwright MCP, and autonomously tests SuperAgent like a real user.

## Structure

- **`runner.ts`** — Test orchestrator. CLI entry point, runs test cases, collects results.
- **`claude-code-driver.ts`** — Spawns `claude` CLI with Playwright MCP. Handles session persistence, timeouts, health checks.
- **`features/`** — 13 feature specs in markdown. Each describes a user-facing surface (chat, agent CRUD, settings, MCP, OAuth, etc.) and serves as prompt input.
- **`setup/`** — Programmatic pre-test steps: inject API tokens, connect OAuth accounts, create agent fixtures, manage Electron lifecycle. Things that are impractical for the agent to do.
- **`test-cases.json`** — Declares test cases: which features to test, which setup steps to run.
- **`results/`** — Output directory (gitignored). Per-feature `.txt` reports, `summary.json`, and screenshot folders for chaos monkey rounds.

## Two Testing Modes

**Feature testing** (`--filter detailed-*`): Runs each feature spec. Agent follows the described flow, verifies behavior, reports pass/fail. Add `--exploration` to inject instructions that encourage the agent to go beyond the happy path.

**Chaos monkey** (`--filter chaos-monkey`): Round-based bug hunting. Agent gets all feature specs as inspiration and is told to go wild. Each round: find one bug → screenshot → JSON report → resume for next. Up to 100 rounds.

## WIP

- **Bug report ↔ screenshot alignment** — Making sure the agent reliably screenshots at the moment of bug discovery so the first image always matches the report.
- **Recording** — Exploring session recording for full repro flows beyond static screenshots.

## Deployment

**Preferred: dedicated local machine.** A Mac Mini (or any machine with a display) with the environment permanently configured — dev server always running, `.env.local` set, browser ready. Run tests on demand via SSH, or add a cron job for nightly chaos monkey runs. Zero CI complexity, fixed cost, results pushed to Slack/Notion/S3.

**Or: CI pipeline.** Feature tests on PR merge, chaos monkey as nightly cron. Requires a self-hosted runner or cloud VM with display server + Electron support — more setup overhead.
