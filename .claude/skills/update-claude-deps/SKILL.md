---
description: Review and upgrade Claude Code CLI, Claude Agent SDK, and Anthropic SDK versions used in the project
---

# Update Claude Dependencies

Review the current versions of Claude-related packages and create an upgrade plan.

## Steps

1. **Find current versions** by reading these files:
   - `agent-container/Dockerfile` — look for the `claude.ai/install.sh` or `npm install -g @anthropic-ai/claude-code` line to find the Claude Code CLI version
   - `agent-container/package.json` — find `@anthropic-ai/claude-agent-sdk` and `@anthropic-ai/sdk` versions
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

- `agent-container/Dockerfile` — Claude Code CLI version (native binary install: `bash -s <VERSION>`)
- `agent-container/package.json` — `@anthropic-ai/claude-agent-sdk` and `@anthropic-ai/sdk`
- `package.json` (root) — `@anthropic-ai/sdk`
- `src/api/llm-sdk-bundle.ts` — **Regenerate after upgrading `@anthropic-ai/sdk`**. This is a pre-built browser bundle of the SDK served to dashboard iframes. Regenerate with:
  ```bash
  npx esbuild node_modules/@anthropic-ai/sdk/index.mjs --bundle --minify --format=iife --global-name=__AnthropicSDK_ns --platform=browser > /tmp/sdk-bundle.js
  echo 'window.__AnthropicSDK = __AnthropicSDK_ns.default || __AnthropicSDK_ns.Anthropic;' >> /tmp/sdk-bundle.js
  ```
  Then replace the template literal in `src/api/llm-sdk-bundle.ts` with the contents of `/tmp/sdk-bundle.js` (escape any backticks with `\``)

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

3. If either E2E file fails, do not ship the bump — check the settlement tracker (`agent-container/src/session-settlement.ts`) and graceful-stop path (`claude-code.ts stop({graceful:true})`) against the new CLI's stream behavior.

## Important notes

- The Claude Code CLI is installed as a native binary in Docker (not npm). Version is pinned via `curl -fsSL https://claude.ai/install.sh | bash -s <VERSION>`
- The Claude Agent SDK versions track in lockstep with Claude Code releases (SDK 0.2.x ↔ CLI 2.1.x) — upgrade both together
- `DISABLE_AUTOUPDATER=1` is set in the Dockerfile to prevent runtime updates
- Do NOT run `npm build` — use typecheck + lint to verify changes
