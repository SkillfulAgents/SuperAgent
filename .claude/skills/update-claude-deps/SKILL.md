---
description: Review and upgrade Claude Code CLI, Claude Agent SDK, and Anthropic SDK versions used in the project
---

# Update Claude Dependencies

Review the current versions of Claude-related packages and create an upgrade plan.

## Steps

1. **Find current versions** by reading these files:
   - `agent-container/package.json` — find `@anthropic-ai/claude-agent-sdk` and `@anthropic-ai/sdk` versions. The agent SDK version IS the CLI version (the CLI ships inside it as native-binary optional deps; SDK 0.3.x ↔ CLI 2.1.x by patch number)
   - `package.json` (root) — find `@anthropic-ai/sdk` version

2. **Check latest versions** by searching the web for:
   - Latest `@anthropic-ai/claude-code` version on npm / GitHub releases
   - Latest `@anthropic-ai/claude-agent-sdk` version on npm
   - Latest `@anthropic-ai/sdk` version on npm
   - Changelogs / release notes for each

3. **Analyze the diff** between current and latest:
   - List new features added between current and latest versions
   - Identify any breaking changes or deprecations
   - Note bug fixes relevant to our usage (especially memory leaks, stability)
   - Check if the npm install method is still supported or if native binary is required

4. **Assess risk** based on our actual SDK usage in the codebase:
   - `agent-container/src/claude-code.ts` uses `query()`, `tool()`, `createSdkMcpServer()`, message types
   - Root project uses `new Anthropic()` and `client.messages.create()`
   - Check if any APIs we use have changed

5. **Present findings** as a table showing:
   - Package name, current version, latest version, delta
   - Risk level (low/medium/high) with justification
   - Key new features and bug fixes worth upgrading for
   - Any breaking changes that would require code modifications

6. **Ask the user** if they want to proceed with the upgrade before making changes.

## Key files to update when upgrading

- `agent-container/package.json` — `@anthropic-ai/claude-agent-sdk` (which carries the CLI binary — no separate Dockerfile pin) and `@anthropic-ai/sdk`
- `package.json` (root) — `@anthropic-ai/sdk`
- `src/api/llm-sdk-bundle.ts` — **Regenerate after upgrading `@anthropic-ai/sdk`**. This is a pre-built browser bundle of the SDK served to dashboard iframes. Regenerate with:
  ```bash
  npx esbuild node_modules/@anthropic-ai/sdk/index.mjs --bundle --minify --format=iife --global-name=__AnthropicSDK_ns --platform=browser --external:'node:*' > /tmp/sdk-bundle.js
  echo 'window.__AnthropicSDK = __AnthropicSDK_ns.default || __AnthropicSDK_ns.Anthropic;' >> /tmp/sdk-bundle.js
  ```
  The `--external:'node:*'` flag is required since SDK 0.116+: the credential-chain code lazily `import()`s `node:fs`/`node:path` behind runtime guards that never fire in a browser, and esbuild errors on them without the external marker.
  Then replace the template literal in `src/api/llm-sdk-bundle.ts` with the contents of `/tmp/sdk-bundle.js` (escape backslashes first, then backticks and `${`), and verify the escaped literal evaluates back to the exact raw bundle

## Validation after upgrading

1. **Container unit suite**: `cd agent-container && npx vitest run` — includes the settlement-tracker fixture replays (19 real captured SDK streams), which catch most protocol-shape regressions.

2. **Gated session-GC E2E suites** (MANDATORY on any `@anthropic-ai/claude-agent-sdk` / CLI bump — CI never runs these, and they guard CLI-behavior assumptions the idle-eviction reaper depends on):
   ```bash
   cd agent-container
   RUN_SESSION_GC_E2E=1 ANTHROPIC_API_KEY=... npx vitest run src/session-gc.e2e.test.ts
   RUN_SESSION_GC_E2E=1 ANTHROPIC_API_KEY=... npx vitest run src/session-gc-durability.e2e.test.ts
   ```
   - Run the two files **separately**, never in one vitest invocation: the pgrep zero-process assertions in each see the other worker's CLI subprocesses.
   - Costs real API tokens (~$0.05, ~1.5 min total on haiku).
   - What they hold in place, and what breaks silently if an SDK/CLI change violates it:
     - the CLI does NOT emit `session_state_changed:idle` between a finished turn and a queued follow-up (violation → the reaper kills queued messages);
     - an interrupt yields a `result` + `idle` so the session settles (violation → every user Stop pins a ~250MB parked subprocess forever);
     - the CLI exits cleanly on stdin EOF, flushing its transcript (violation → eviction silently loses the latest turns / `shouldQuery:false` appends on the next `--resume`);
     - `--resume` resumes in-place with the same session id, with prior context intact.

3. **Task-tools escape hatch** (MANDATORY re-verify on any CLI bump): `claude-code.ts buildQueryOptions()` pins `CLAUDE_CODE_ENABLE_TODO_TOOLS: 'true'` in the subprocess env because CLI 2.1.233+ stops registering TaskCreate/TaskGet/TaskList/TaskUpdate on newer models (opus ≥4.8, sonnet/fable/mythos ≥5). The in-chat task-list UI (`derive-task-list.ts`) and existing agent workflows depend on those tools. This env var is an **undocumented escape hatch** — Anthropic can drop it in any release, and the failure is silent (tools just stop appearing; nothing errors). To re-verify: run the `claude-prompt-drift` skill's capture after the bump and confirm the superagent-axis `tools.md` still lists all four Task tools. If they've vanished, the CLI's only other re-enable path is a server-side feature flag that our `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` blocks — so escalate to a product decision (patch the gate, or retire the task-list UI's wire dependency) rather than shipping silently.

4. If either E2E file fails, do not ship the bump — check the settlement tracker (`agent-container/src/session-settlement.ts`) and graceful-stop path (`claude-code.ts stop({graceful:true})`) against the new CLI's stream behavior.

5. **Vendored bundled skill/workflow drift** (MANDATORY on any `@anthropic-ai/claude-agent-sdk` / CLI bump): `claude-code.ts buildQueryOptions()` sets `disableBundledSkills: true`, which strips every skill and workflow that ships inside the CLI, and the image-baked Gamut plugin (`agent-container/plugin/`, see its README) carries copies of the ones we keep — the `deep-research` workflow and the `workflow-authoring` skill (the Workflow tool's own prompt tells the model to load it; without it the model writes workflow scripts blind). Those copies no longer track upstream, so after `npm ci` in `agent-container/` run
   ```bash
   node .claude/skills/update-claude-deps/extract-bundled.mjs
   ```
   - exit 0 → no drift, nothing to do;
   - exit 1 → it prints a unified diff per drifted entry against what is embedded in the new binary. Read the diff (prompt wording, vote thresholds, fetch budgets, schema changes, new script-API guidance), then adopt it with `--write` unless a change is clearly wrong for us — each file must stay identical to upstream apart from the entry's `patches` in the extractor's `VENDORED` table (mechanical one-line substitutions such as the `gamut:` workflow prefix), so any bigger local edit means forking under a new name instead;
   - exit 2 → the extractor could not find or parse a chunk, could not resolve an identifier the prompt text interpolates (pin it under that entry's `constants`), or a patch no longer matches upstream. Fix the extractor (its header comment explains the expected shapes) rather than shipping blind.
   While there, list what the new CLI bundles (`grep -a -o 'var i="[a-z-]*",e=i,' <binary>` for workflows; the `skills` array in a headless run's `system:init` message for skills) and decide whether anything new is worth vendoring the same way — `disableBundledSkills` hides all of it, so a useful addition is invisible until someone looks.

## Important notes

- The Claude Code CLI ships inside `@anthropic-ai/claude-agent-sdk` as per-platform native-binary optional dependencies (`claude-agent-sdk-<os>-<arch>`); the Dockerfile symlinks the bundled binary onto PATH. There is no separate install.sh/npm CLI install to pin — bumping the SDK version bumps the CLI.
- SDK and CLI versions track in lockstep by patch number (SDK 0.3.x ↔ CLI 2.1.x, e.g. 0.3.238 ↔ 2.1.238)
- `DISABLE_AUTOUPDATER=1` is set in the Dockerfile to prevent runtime updates
- Bundled CLI skills/workflows are disabled in agent sessions (`disableBundledSkills`); `deep-research` and `workflow-authoring` are vendored under `agent-container/plugin/` and checked for drift by `extract-bundled.mjs` in this skill's directory (validation step 5)
- Do NOT run `npm build` — use typecheck + lint to verify changes
