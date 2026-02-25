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

## Important notes

- The Claude Code CLI is installed as a native binary in Docker (not npm). Version is pinned via `curl -fsSL https://claude.ai/install.sh | bash -s <VERSION>`
- The Claude Agent SDK versions track in lockstep with Claude Code releases (SDK 0.2.x ↔ CLI 2.1.x) — upgrade both together
- `DISABLE_AUTOUPDATER=1` is set in the Dockerfile to prevent runtime updates
- Do NOT run `npm build` — use typecheck + lint to verify changes
