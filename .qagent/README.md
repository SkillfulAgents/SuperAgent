# SuperAgent — QAgent Test Configuration

This directory contains the [QAgent](https://github.com/yiw190/QAgent) test configuration for SuperAgent.

QAgent is the agentic E2E testing framework. All orchestration, prompt building, and driver logic lives there. This `.qagent/` folder is purely **configuration**:

- `stories/` — YAML test stories (recursive, supports subdirectories)
- `features/` — Markdown feature specs (UI reference for the AI agent)
- `hooks/` — TypeScript lifecycle hooks (setup + teardown)
- `.env.local` — Environment variables (API keys, etc.)

## Prerequisites

- Claude CLI (`claude`) installed and authenticated
- SuperAgent running at `http://localhost:47891` (or specify `--base-url`)

## Setup

```bash
# Install QAgent from GitHub
npm install --save-dev github:SkillfulAgents/qagent

# Copy env template
cp .qagent/.env.example .qagent/.env.local
# Fill in your ANTHROPIC_API_KEY (and optionally COMPOSIO_* for integrations tests)
```

## Running Tests

```bash
# Smoke test (happy-path, ~2 min)
npx qagent run --project-dir .qagent --filter smoke

# All feature tests
npx qagent run --project-dir .qagent --filter feature_test/

# Single feature test
npx qagent run --project-dir .qagent --filter core

# Chaos monkey
npx qagent run --project-dir .qagent --filter chaos

# Electron tests (start Electron with --remote-debugging-port=9222 first)
npx qagent run --project-dir .qagent --filter product-surface-electron

# Full suite
npx qagent run --project-dir .qagent
```

## Hooks

Each file in `hooks/` exports a `default async function(ctx: SetupContext)`. Reference them by filename (without extension) in story YAML `setup`/`teardown` arrays.
