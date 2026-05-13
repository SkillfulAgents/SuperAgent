---
description: Detect drift in the Claude system prompt that agent-container sends to Anthropic. Captures two axes — the bare `claude_code` preset (Anthropic baseline) and agent-container's overlaid wire request — at the SDK version pinned in `agent-container/package-lock.json`, then stores versioned snapshots under `snapshots/<sdk-version>/`. Use when bumping `@anthropic-ai/claude-agent-sdk`, debugging unexpected model behavior after an SDK upgrade, or auditing what Anthropic silently changed in the Claude Code preset.
---

# Claude Prompt Drift Check

Container-orchestrated capture + diff of the `/v1/messages` request body that the claude-agent-sdk emits, at two layers:

| Axis          | What it captures                                                                              |
| ------------- | --------------------------------------------------------------------------------------------- |
| `pure-claude` | The bare `{ type: 'preset', preset: 'claude_code' }` baseline — no MCP, no append, no custom tools |
| `superagent`  | What `agent-container` actually puts on the wire (skills, MCP, claudeMd, etc.)                |

The diff *between* the two axes in a single snapshot is **our known modifications** — intentional, not interesting. The interesting signal is each axis's drift *across SDK versions*:

- `pure-claude` drift → Anthropic changed the preset (new skill_listing entry, new system-reminder, tool description rewritten).
- `superagent` drift → our overlay changed (we added/removed an MCP server, edited claudeMd, bumped SDK).

## When to use

- After bumping `@anthropic-ai/claude-agent-sdk` in `agent-container/package.json`.
- "Model is behaving weirdly since the SDK upgrade" — diff to see what shifted.
- Auditing whether a SuperAgent code change leaked into the on-wire system prompt unintentionally.

## Prerequisites

- **Docker** running.
- `jq`, `curl` on PATH.
- Skill must be run from inside the SuperAgent repo (`agent-container/` accessible at `../../../agent-container`).
- No host Node.js required — the proxy and the pure-claude baseline driver both run inside containers built from `agent-container`'s own image (glibc, with the `claude` native binary pre-installed). This avoids the local API-key validation issue that bites Alpine/musl + `npm install` setups.

## Usage

### Capture the current SDK version

```bash
cd /path/to/SuperAgent
.claude/skills/claude-prompt-drift/capture.sh
```

The script:

1. Reads the pinned SDK version from `agent-container/package-lock.json`.
2. Builds the `superagent-container` image (cached if unchanged).
3. Brings up a private Docker network with three containers:
   - `proxy-*`: pass-through proxy that dumps `body.system` / `body.messages` / `body.tools` as Markdown on first sight of each `model`, then forwards to `api.anthropic.com`.
   - `superagent-*`: `agent-container` itself, pointed at the proxy via `ANTHROPIC_BASE_URL`.
   - `baseline-*`: same `superagent-container` image, but with the CMD overridden to run a bare `query({ systemPrompt: { type: 'preset', preset: 'claude_code' } })` driver — this reuses the already-installed `claude` native binary so it actually issues the wire request.
4. Fires one model call against each axis.
5. Tears everything down.

Output lands in `snapshots/<sdk-version>/`. See [snapshots/README.md](./snapshots/README.md) for layout.

### Flags

| Flag                    | Default              | Meaning                                                  |
| ----------------------- | -------------------- | -------------------------------------------------------- |
| `--model`               | `claude-opus-4-7`    | Model id to capture (one snapshot per model)             |
| `--axis`                | `both`               | `pure-claude`, `superagent`, or `both`                   |
| `--force`               | off                  | Re-capture even if a snapshot already exists             |
| `--anthropic-api-key`   | `dummy-for-capture`  | API key passed to containers. The proxy captures the request body **before** forwarding upstream, so a 401 from Anthropic is fine — but Claude Code's CLI now does light local validation that may need a real-looking key. Pass a real key only if you also want to verify forwarding works end-to-end. |
| `--superagent-path`     | _auto_               | Override path to SuperAgent repo (default: derived from skill location) |

### Diff two captured versions

```bash
.claude/skills/claude-prompt-drift/diff.sh <old-sdk-version> <new-sdk-version>           # both axes
.claude/skills/claude-prompt-drift/diff.sh <old> <new> --axis pure-claude                # Anthropic drift only
.claude/skills/claude-prompt-drift/diff.sh <old> <new> --axis superagent --model claude-opus-4-7
```

Exits non-zero if any drift is detected (CI-friendly).

## Files

```
claude-prompt-drift/
├── SKILL.md
├── capture.sh                   ← one-shot orchestrator (containers + proxy + drive)
├── diff.sh                      ← cross-version diff helper
├── proxy.mjs                    ← pass-through capture proxy (runs in node:20 container)
├── pure-baseline/run.mjs        ← bare-preset SDK driver (runs inside agent-container image)
└── snapshots/
    ├── README.md
    └── <sdk-version>/{pure-claude,superagent}/<model>/{system,messages,tools}.md + meta.json
```

## What "known modifications" means

When you look at a single snapshot, the diff between `pure-claude/<model>/system.md` and `superagent/<model>/system.md` is everything `agent-container` layers on top: skill listing, MCP instructions, custom claudeMd, etc. **That diff is expected and is not what this skill is for.** This skill is purely about tracking how each axis evolves over time.

## Notes

- One capture per `(sdk-version, axis, model)` is intentional — captures are large and the static prefix is stable per session. Use `--force` to override.
- `raw.json` is excluded from diffs because it duplicates the rendered `.md` files. Snapshots commit only the `.md` renderings + `meta.json`.
- `superagent` axis needs the agent-container HTTP server to come up. If the container fails to start, capture aborts and prints the container logs.
- `pure-baseline/run.mjs` uses the SDK that's already installed inside the agent-container image — there is no separate `npm install`. This avoids the glibc/musl mismatch that broke the first attempt at running the baseline driver under `node:20-alpine`.
