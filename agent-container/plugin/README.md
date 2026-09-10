# The Gamut plugin

This directory is a Claude Code plugin (`.claude-plugin/plugin.json` at the
root, `skills/` and `workflows/` beside it). The Dockerfile bakes it into
`/opt/gamut/plugin`, read-only, and every agent session loads it through the
SDK `plugins` option in `claude-code.ts` (`gamut-plugin.ts` holds the path).

Why a plugin: the CLI discovers skills only under `$CLAUDE_CONFIG_DIR`
(`/workspace/.claude`, agent-writable, on the per-agent bind mount) and inside
plugins. Files copied into `~/.claude` are never read — that is how the
dashboards and widgets skills went invisible to the model while the system
prompt kept telling it to load them. A plugin outside `/workspace` needs no
runtime provisioning, cannot be edited or deleted by the agent, and is exempt
from the `disableBundledSkills` setting that strips the CLI's own bundled
skills from our sessions.

Names are plugin-qualified in the model's listing (`gamut:dashboards`,
`gamut:widgets`, `gamut:deep-research`); the Skill tool also resolves the bare
name. A workflow is addressed by its qualified name:
`Workflow({name: 'gamut:deep-research', args: '<question>'})`.

## skills/

- `dashboards/` — building interactive dashboards; also holds the React/Vite
  template that `dashboard-manager.ts` scaffolds from and the reference docs
  the dashboard-builder prompt points at (`/opt/gamut/plugin/skills/dashboards/*.md`).
- `widgets/` — building home-screen widgets; holds the template
  `widget-manager.ts` scaffolds from.
- `workflow-authoring/` — vendored from the CLI (see below): the script-API
  reference the Workflow tool's own prompt tells the model to load before
  writing a workflow. Without it the model authors scripts blind.

## workflows/

- `deep-research.js` — fan-out web search → fetch → 3-vote adversarial verify →
  cited report. Needs the Workflow tool (`enableWorkflows`), WebSearch and
  WebFetch, exactly like upstream.

## Vendored from the CLI

`workflows/deep-research.js` and `skills/workflow-authoring/SKILL.md` are
extracted from the Claude Code CLI binary. We disable the bundled set
(developer-workflow skills that fire on their own and compete with our
guidance) and keep only what we want. Keep these files identical to upstream
except for the `patches` listed per entry in the extractor's `VENDORED` table
(today: the usage hint in deep-research says `gamut:deep-research`, because a
plugin workflow is addressed by its qualified name). The extractor applies the
same patches to the upstream text before diffing, so the drift check stays a
plain diff. On every `@anthropic-ai/claude-agent-sdk` bump:

```bash
node .claude/skills/update-claude-deps/extract-bundled.mjs         # diff all
node .claude/skills/update-claude-deps/extract-bundled.mjs --write # adopt all
```

(step 5 of the `update-claude-deps` skill's validation list). Any further local
change goes into that entry's `patches` if it is a one-line mechanical
substitution; anything bigger means forking under a different name.
