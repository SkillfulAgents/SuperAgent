---
description: Detect drift in the Claude system prompt that agent-container sends to Anthropic. Captures two axes — the bare `claude_code` preset (Anthropic baseline) and agent-container's overlaid wire request — at the SDK version pinned in `agent-container/package-lock.json`, then stores versioned snapshots in `<skill>/snapshots/` (gitignored). Use when bumping `@anthropic-ai/claude-agent-sdk`, debugging unexpected model behavior after an SDK upgrade, previewing what a PR changes in the on-wire prompt, or auditing what Anthropic silently changed in the Claude Code preset.
---

# Claude Prompt Drift Check

Capture + diff of the `/v1/messages` request body that `claude-agent-sdk` emits, at two layers:

| Axis          | What it captures                                                                              |
| ------------- | --------------------------------------------------------------------------------------------- |
| `pure-claude` | Bare `{ type: 'preset', preset: 'claude_code' }` baseline — no MCP, no append, no custom tools |
| `superagent`  | What `agent-container` actually puts on the wire (skills, MCP, claudeMd, etc.)                |

The diff *between* the two axes in a single snapshot is **our known modifications** — intentional, not interesting. The interesting signal is each axis's drift *across captures*:

- `pure-claude` drift → Anthropic changed the preset.
- `superagent` drift → our overlay changed (added/removed an MCP server, edited claudeMd, bumped SDK, etc.).

## Files in this skill

```
.claude/skills/claude-prompt-drift/
├── SKILL.md
├── .gitignore                ← ignores `snapshots/`
├── capture.sh                ← orchestrator (containers + proxy + drive)
├── diff.sh                   ← cross-snapshot diff
├── proxy.mjs                 ← pass-through capture proxy (runs in node:20 container)
├── pure-baseline/run.mjs     ← bare-preset SDK driver (runs inside agent-container image)
└── snapshots/                ← captured data, local only (gitignored)
```

`snapshots/` is build output, not source. It lives next to the script so it's trivially discoverable (`ls .claude/skills/claude-prompt-drift/snapshots/`) but never enters git.

## Snapshot layout

Default location: `<this skill>/snapshots/`. Override precedence: `--snapshots-dir <path>` > `$SNAPSHOTS_DIR` env > default.

Layout under the snapshots root:

```
pure-claude/<sdk-version>/<model>/{system,messages,tools}.md + meta.json
superagent/<sa-key>/<model>/{system,messages,tools}.md + meta.json
```

`<sa-key>` shape:

| Source           | Shape                              | Example                       |
| ---------------- | ---------------------------------- | ----------------------------- |
| main / release   | `<sdk>+<sa-version>`               | `0.2.118+0.3.24`              |
| `--pr <num>`     | `<sdk>+pr<num>-<short-sha>`        | `0.2.118+pr73-fef927c2`       |
| dirty tree       | suffix `-dirty` (needs `--allow-dirty`) | `0.2.118+0.3.24-dirty`   |

The two axes are keyed differently because they depend on different things: `pure-claude` only on the SDK version, `superagent` also on what SuperAgent ships. Mixing them in one key would silently overwrite the superagent axis when SuperAgent changes without an SDK bump.

## When to use

- After bumping `@anthropic-ai/claude-agent-sdk` in `agent-container/package.json`.
- "Model is behaving weirdly since the SDK upgrade" — diff to see what shifted.
- Reviewing a PR that touches `agent-container` prompts/tools — capture the PR head and diff against main.
- Auditing whether Anthropic silently changed the `claude_code` preset.

## Prerequisites

- Docker running.
- `jq`, `curl`, `git` on PATH.
- Skill run from inside the SuperAgent repo (so `--superagent-path` can auto-resolve).

## Usage

### Capture the current SDK version (default = working tree)

```bash
cd /path/to/SuperAgent
.claude/skills/claude-prompt-drift/capture.sh
```

### Capture a PR head without touching the working tree

```bash
.claude/skills/claude-prompt-drift/capture.sh --pr 73
```

`--pr` fetches `origin/pull/<num>/head`, builds in a detached worktree, captures, removes the worktree on exit.

### Capture against an arbitrary checkout

```bash
git worktree add --detach /tmp/sa-old origin/main~10
.claude/skills/claude-prompt-drift/capture.sh --superagent-path /tmp/sa-old
git worktree remove /tmp/sa-old
```

### Flags

| Flag                    | Default                                    | Meaning                                                  |
| ----------------------- | ------------------------------------------ | -------------------------------------------------------- |
| `--model`               | `claude-opus-4-7`                          | Model id (one snapshot per model)                        |
| `--axis`                | `both`                                     | `pure-claude`, `superagent`, or `both`                   |
| `--pr <num>`            | _none_                                     | Capture against a PR head (mutually exclusive with `--superagent-path`) |
| `--force`               | off                                        | Re-capture even if snapshot exists                       |
| `--allow-dirty`         | off                                        | Allow `superagent` capture from a dirty working tree. Key gets a `-dirty` suffix. |
| `--snapshots-dir`       | `$SNAPSHOTS_DIR` or `<skill>/snapshots`    | Where to write snapshots (gitignored at the default location) |
| `--superagent-path`     | _auto_                                     | Override SuperAgent repo path                            |
| `--anthropic-api-key`   | `dummy-for-capture`                        | API key passed to the containers. Proxy captures the request body **before** forwarding upstream, so a 401 is fine. Claude Code's CLI does light local validation — pass a real-looking key if it complains. |

### Diff two snapshots

```bash
.claude/skills/claude-prompt-drift/diff.sh pure-claude <old-sdk> <new-sdk>
.claude/skills/claude-prompt-drift/diff.sh superagent  <old-key> <new-key>
```

Exits non-zero on drift (CI-friendly). Diff is per-axis on purpose — the two axes have different key shapes.

## What "known modifications" means

In a single capture, the diff between `pure-claude/<sdk>/<model>/system.md` and `superagent/<key>/<model>/system.md` is everything `agent-container` layers on top: skill listing, MCP instructions, custom claudeMd, etc. **That diff is expected and is not what this skill is for.** This skill tracks how each axis evolves over time.

## Noise handling

`proxy.mjs` redacts two volatile fields before writing the rendered `.md`:

- The capture timestamp is dropped from `.md` (it lives in `meta.json`).
- `cch=<hex>` in the billing header (system[0]) is replaced with `cch=<redacted>`. Claude Code regenerates this per request even for identical input, so leaving it raw makes every diff flap.

Real signal fields like `cc_version=...` and `cc_entrypoint=` are kept.

## Notes

- One capture per `(axis, key, model)` is intentional — captures are large and the static prefix is stable per session. Use `--force` to redo.
- `raw.json` and `.seen-models.json` are produced during capture but excluded from diffs.
- `pure-baseline/run.mjs` uses the SDK that's already installed inside the agent-container image (no separate `npm install`), avoiding the glibc/musl mismatch that broke earlier attempts at running the baseline under `node:20-alpine`.
- Working tree state matters. When pointing at the working repo directly, the script reads `git rev-parse HEAD` and `git status --porcelain` — make sure that's what you mean to capture (typically `origin/main` or a PR head, not a stale local branch).
- `--model` must match what agent-container actually puts on the wire. The container ignores the session's requested model and uses its own default (currently `claude-opus-4-8`); if `--model` names anything else, the proxy writes the snapshot under the real model's dir while the script polls the wrong path and times out. The pure axis honors `--model` via the `DRIFT_MODEL` env var.
- Windows/Git Bash: capture.sh disables MSYS path conversion for container-side docker args (`MSYS2_ARG_CONV_EXCL`) and renders host mount paths via `cygpath -m` — required, or the `-v` mounts get rewritten to `C:\Program Files\Git\...` and the proxy crash-loops. Needs `jq` on PATH (not bundled with Git for Windows).

## Known caveat: local build ≠ GHCR image

`capture.sh` runs `docker build ./agent-container` locally each invocation; it does **not** pull `ghcr.io/skillfulagents/superagent-agent-container-base:<sha>` (the image users actually run). The two are not byte-identical — different base-image digest resolution, `npm install` transitive-dep timing, build-cache state — so for a strict bit-for-bit integrity audit this skill is not the right tool.

For wire-prompt drift, this is acceptable: `system` / `tools` / `messages` content all originate in `agent-container/src/` (system-prompt.md, MCP registrations, `claude-code.ts` tool wiring), which both the local build and CI bake in the same way. If a finding ever looks suspicious, re-check by pulling the GHCR image at the same SHA and inspecting out-of-band — but the common case doesn't require it.

CI only publishes the base image on push to `main` (see `.github/workflows/build-container.yml`), so for PR captures local build is the only option regardless.
