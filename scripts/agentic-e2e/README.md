# Agentic E2E Tests

Automated end-to-end testing for SuperAgent using Claude Code CLI + Playwright MCP. An AI agent drives the browser, explores the app, and reports bugs.

## Setup

1. Copy `.env.example` to `.env.local` and fill in your API keys:

```bash
cp .env.example .env.local
```

2. Start the SuperAgent dev server:

```bash
# from repo root
npm run dev
```

3. Ensure Docker is running (the test framework creates agent containers via the host API).

## Usage

```bash
# Run all test cases
npx tsx scripts/agentic-e2e/runner.ts

# Run a specific test case
npx tsx scripts/agentic-e2e/runner.ts --filter detailed-core

# Run with verbose output
npx tsx scripts/agentic-e2e/runner.ts --filter detailed-core --verbose

# Chaos monkey mode (exploratory bug hunting)
npx tsx scripts/agentic-e2e/runner.ts --filter chaos-monkey --verbose
```

### CLI Flags

| Flag | Description | Default |
|------|-------------|---------|
| `--filter <id>` | Run only the test case matching this ID | all |
| `--tag <tag>` | Run only test cases with this tag | all |
| `--verbose` | Print full agent output | `false` |
| `--retries <n>` | Max retries per feature on failure | `1` |
| `--base-url <url>` | SuperAgent host URL | `http://localhost:47891` |
| `--target <web\|electron>` | Test target platform | `web` |
| `--exploration` | Enable exploration mode for feature tests | `false` |
| `--model <model>` | Claude model to use | `sonnet` |
| `--budget <usd>` | Override per-feature budget limit | `$5` feature / `$3` chaos |

## Architecture

```
scripts/agentic-e2e/
├── runner.ts                 # Test orchestrator
├── claude-code-driver.ts     # Claude CLI process driver
├── system-prompt.md          # Base agent instructions
├── test-cases.json           # Test case definitions + test data
├── features/                 # Feature specs (UI/UX component docs)
│   ├── session-chat.md
│   ├── agent-settings.md
│   └── ...
├── setup/                    # Pre-test setup modules
│   ├── ensure-secrets.ts     # Inject API keys into host
│   ├── ensure-agent.ts       # Create & start a QA agent
│   ├── ensure-oauth.ts       # Connect OAuth accounts
│   └── launch-electron.ts    # Electron-specific launcher
└── results/                  # Test output (gitignored)
    ├── summary.json
    └── <testcase>--<feature>/
        ├── report.md
        └── *.png
```

### Two Test Modes

- **Feature testing**: Walks through each feature spec (happy path + edge cases). Retries on failure with previous failure context injected into the prompt.
- **Chaos monkey**: Round-based exploratory testing. The agent freely navigates the app trying to break things, reporting one bug per round.

### Output Format

Reports use structured markdown markers:

- `[TEST_PASS]` / `[TEST_FAIL]` — overall result (first line)
- `[REASON]` — one-line summary
- `[BUG_FOUND]` — bug description (one per bug)
- `[STEP]` — action taken and result observed
