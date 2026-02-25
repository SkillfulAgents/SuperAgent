---
description: Check and update to the latest Claude model versions across the codebase
---

# Update Models

Check which Claude models are configured in the project and update to the latest versions.

## Steps

1. **Find current model references** by searching the codebase for model ID patterns:
   - `src/shared/lib/config/settings.ts` — default model settings (`agentModel`, `browserModel`, `summarizerModel`)
   - `src/renderer/components/settings/llm-tab.tsx` — model dropdown options and fallback values
   - `src/renderer/components/settings/browser-tab.tsx` — browser model dropdown options and fallback values
   - `agent-container/src/claude-code.ts` — model alias mapping (`toModelAlias` function)
   - Search broadly for any other hardcoded model IDs: `grep -r "claude-.*-[0-9]" src/ agent-container/src/`

2. **Check latest available models** by searching the web for:
   - Latest Claude model family versions (Opus, Sonnet, Haiku)
   - Latest model IDs on the Anthropic API
   - Any new model tiers or capabilities

3. **Present findings** showing:
   - Current model IDs used in each file
   - Latest available model IDs
   - What changed (new capabilities, context window, pricing changes)

4. **Ask the user** which models to update before making changes.

## How model resolution works

The codebase stores full model IDs (e.g., `claude-opus-4-6`) in settings and UI dropdowns. In `agent-container/src/claude-code.ts`, the `toModelAlias()` function maps these to SDK aliases (`opus`, `sonnet`, `haiku`). The Claude Agent SDK then resolves aliases to the actual latest model version.

This means:
- **UI dropdowns and defaults**: Use full model IDs for display (e.g., `claude-opus-4-6`, label `Claude 4.6 Opus`)
- **SDK calls**: Full model IDs get mapped to aliases via `toModelAlias()` — the SDK handles version resolution
- **Summarizer model** (`summarizerModel` in settings.ts): Uses `@anthropic-ai/sdk` directly with `client.messages.create()` — this takes the full model ID string as-is

## Key files to update

- `src/shared/lib/config/settings.ts` — default model values
- `src/renderer/components/settings/llm-tab.tsx` — `MODEL_OPTIONS` array and fallback value
- `src/renderer/components/settings/browser-tab.tsx` — `MODEL_OPTIONS` array and fallback value

## Important notes

- The `toModelAlias()` function in `agent-container/src/claude-code.ts` maps any string containing "opus"/"sonnet"/"haiku" to the alias — so the exact version number in the model ID doesn't affect SDK behavior, but it does affect what the user sees in the UI
- Haiku may not have a newer version when Opus/Sonnet do — check each independently
- Do NOT run `npm build` — use typecheck + lint to verify changes
