# CCUsage calculation regression audit and fixes

Audit date: 2026-08-20; Sonnet 5 pricing updated 2026-08-21

## Scope and method

The original dependency declaration is `ccusage@^15.2.0`, with the lockfile resolving exactly 15.2.0. Commit `aa6c487a` called `ccusage/data-loader` directly; commit `4f8b575c` replaced that production path with the current hand-written loader after usage tracking caused an OOM. CCUsage 15.2 remains only as a test/reference dependency. The existing parity assertions compare selected old behavior and explicitly permit local output/cost to be higher, so they cannot detect most later regressions.

This audit reviewed CCUsage releases and calculation changes from [v15.2.0](https://github.com/ccusage/ccusage/releases/tag/v15.2.0) through [v20.0.20](https://github.com/ccusage/ccusage/releases/tag/v20.0.20), then mapped the upstream parser, aggregation, deduplication, and pricing tests onto `src/shared/lib/services/usage-service.ts`.

Verification used three layers:

1. The existing local usage suite passed before adding regressions: 102/102 tests.
2. Upstream fixtures and assertions were ported into `usage-service.ccusage-regressions.test.ts` and run against the local implementation.
3. The structural fixtures were also checked against the native CCUsage v20.0.20 binary where useful. Its outputs agreed with the upstream tests and exposed the same local deltas.

Before the fixes, all 12 original ported regressions failed. Implementation review reproduced three additional calculation defects and expanded the file to 31 orderings, boundaries, and hardening scenarios. All 31 now pass while the original 102-test usage suite remains green.

## Verified and fixed regressions

The “local result” column records the pre-fix behavior that was reproduced in this app; it is retained as evidence of the original failure.

| # | Bug | First upstream release | Pre-fix local result | Expected result | Primary local cause |
|---|---|---|---|---|---|
| 1 | A later snapshot can have equal output but more input/cache usage | [v19.0.0](https://github.com/ccusage/ccusage/releases/tag/v19.0.0), [PR #984](https://github.com/ccusage/ccusage/pull/984) | 101 tokens, $0.01 | 1,101 tokens, $0.02 | Duplicate replacement compares only `outputTokens`, not total usage. |
| 2 | Distinct non-sidechain requests that reuse a message ID are collapsed | [v19.0.0](https://github.com/ccusage/ccusage/releases/tag/v19.0.0), [PRs #984](https://github.com/ccusage/ccusage/pull/984) / [#985](https://github.com/ccusage/ccusage/pull/985) | 26 tokens, $0.02 | 41 tokens, $0.03 | The key is globally just `message.id`; upstream normally uses `(message.id, requestId)`. |
| 3 | `/btw` sidechain replay wins when it is read first | [v20.0.5](https://github.com/ccusage/ccusage/releases/tag/v20.0.5), [issue #913](https://github.com/ccusage/ccusage/issues/913), [fix](https://github.com/ccusage/ccusage/commit/cb26b5c99de82c142292a34ffd089b9f7fbf7073) | 50,010 tokens, $0.01515 | 30 tokens, $0.000156 | `isSidechain` and `requestId` are ignored, so an equal-output parent cannot replace the replay. |
| 4 | Nested cache durations are ignored; 1h writes use the 5m rate | [v20.0.8](https://github.com/ccusage/ccusage/releases/tag/v20.0.8), [PR #1221](https://github.com/ccusage/ccusage/pull/1221), [issue #899](https://github.com/ccusage/ccusage/issues/899) | 1,029 tokens, $0.00375525 | 60 tokens, $0.0001665 | Only flat `cache_creation_input_tokens` and one cache-write rate exist. The upstream sentinel fixture requires nested `10` 5m + `20` 1h to override flat `999`. |
| 5 | Advisor-model iterations are omitted | [v20.0.17](https://github.com/ccusage/ccusage/releases/tag/v20.0.17), [PR #1423](https://github.com/ccusage/ccusage/pull/1423), [issue #1115](https://github.com/ccusage/ccusage/issues/1115) | input 2, output 491, one model, $1.23 | input 159,421, output 8,296, two models, $4.20666 | `usage.iterations[]` is never expanded into separately priced advisor rows. |
| 6 | Historical Opus 4.6 fast mode is billed at standard speed | [v18.0.10](https://github.com/ccusage/ccusage/releases/tag/v18.0.10), [PR #886](https://github.com/ccusage/ccusage/pull/886) | $0.0175 | $0.105 | `usage.speed` is parsed, but the Opus 4.6 6x multiplier is absent. This affects imported/legacy fast rows, not ordinary current model choices. |
| 7 | Historical Claude 1M-context rates are absent | [v17.0.0](https://github.com/ccusage/ccusage/releases/tag/v17.0.0), [PR #651](https://github.com/ccusage/ccusage/pull/651), [issue #568](https://github.com/ccusage/ccusage/issues/568) | $5.85 | $6.915 | The historical Sonnet 4 rate card has no marginal `*_above_200k` rates. Current Sonnet 4.6's full 1M window at flat rates is a separate, correctly flat case. |
| 8 | Cache writes do not select the whole-request long-context tier | [v20.0.20](https://github.com/ccusage/ccusage/releases/tag/v20.0.20), after semantics in [v20.0.15](https://github.com/ccusage/ccusage/releases/tag/v20.0.15); [PR #1541](https://github.com/ccusage/ccusage/pull/1541) | $0.408 | $0.816 using the app's own configured base/high Grok rates | The threshold sums fresh input + cache reads, but omits cache writes. |
| 9 | Provider-prefixed Claude catalog IDs lose the canonical cache-write ratio | [v17.1.7](https://github.com/ccusage/ccusage/releases/tag/v17.1.7), [PR #743](https://github.com/ccusage/ccusage/pull/743) class | Bedrock Sonnet 4.6: $3.00 per 1M cache writes | $3.75 | Catalog construction looks up static metadata by the prefixed ID, misses, then defaults cache creation to 1x input instead of 1.25x. |
| 10 | GLM cache creation is billed like fresh input instead of free | [v20.0.8](https://github.com/ccusage/ccusage/releases/tag/v20.0.8), [PR #1235](https://github.com/ccusage/ccusage/pull/1235) | OpenRouter GLM 5.2: $1.20 per 1M cache writes | $0 | The catalog schema cannot express cache rates and the generic fallback uses the input rate. CCUsage v20.0.20 prices fresh input for this model, confirming that zero cache cost is not an unknown-model fallback. |
| 11 | Sonnet 5 is billed at a cancelled future price | Current [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing) | The table and catalog switch from $2/$10 to $3/$15 on 2026-09-01 | $2/$10 permanently, with $2.50/$4/$0.20 cache-write/read rates | The initial fix encoded the launch-time increase, but Anthropic subsequently made the introductory rates standard and cancelled the increase. |
| 12 | Opus 5 base rates contain its fast-mode price | Current [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing) | 1M input + 1M output costs $60 | $30 | The table stores $10/$50 as base, then applies another 2x for fast; official base is $5/$25 and fast is $10/$50. |
| 13 | Equal-token duplicates can retain a lower recorded cost | [v19.0.0](https://github.com/ccusage/ccusage/releases/tag/v19.0.0), [PR #984](https://github.com/ccusage/ccusage/pull/984) | Two otherwise identical snapshots costing $0.01 then $0.02 retain $0.01 | $0.02 | The local duplicate selector had no cost tie-break after comparing token totals. |
| 14 | Invalid or unrepresentable token values are accepted | Current [v20.0.20](https://github.com/ccusage/ccusage/releases/tag/v20.0.20) parser behavior, plus JavaScript integer safety | `input_tokens: -100` produces -100 tokens and -$0.0003 | Skip negative/fractional usage; reject JavaScript-unsafe integers locally; mark the result incomplete | The parser checked only for finite numbers rather than non-negative safe integers. |
| 15 | A process spanning a scheduled price cutoff can keep the old catalog rate | Independent local integration bug | A post-cutoff row remains on the pre-cutoff rate until app restart | The new scheduled rate applies immediately at the cutoff | Built-in catalog pricing is evaluated at module import, then a later `Date.now()` comparison can mistake that frozen card for a user override and drop the schedule. This remains covered with a synthetic schedule now that Sonnet 5 has no cutoff. |

Rows 1-10 and 13-14 are mapped to released/current CCUsage behavior. Rows 11-12 are independent pricing drift discovered by comparing the app, CCUsage v20.0.20, and Anthropic's current pricing. Row 11 was updated again on 2026-08-21 after Anthropic explicitly cancelled Sonnet 5's scheduled increase. Row 15 is a local lifecycle bug exposed while integrating effective-dated pricing.

Pricing-only failures matter when the transcript does not contain an authoritative `costUSD`, or when the loader deliberately recomputes a speed tier. Token parsing and deduplication failures affect displayed token totals regardless and can also select or omit recorded costs.

The implementation fixes these at their respective layers:

- Transcript parsing now recognizes nested 5m/1h cache buckets and advisor iterations.
- Deduplication is request- and sidechain-aware, applies CCUsage's token/cost/speed richness ordering, and reconciles request-less fallbacks deterministically without collapsing distinct normal requests.
- Pricing handles duration-specific cache writes, marginal and whole-request context tiers, speed multipliers, effective-dated rates, provider-prefixed canonical metadata, and explicit zero cache rates.
- The built-in pricing table now contains the verified historical/current Claude and GLM corrections.
- Catalog price edits preserve cache metadata, and the pricing refresh script merges flat updates without deleting hand-maintained tiers, schedules, or non-Claude models.

## Release trail for calculation-relevant changes

- v17.0.0: marginal long-context rate fields for historical Claude 1M-context usage (#651).
- v17.1.7: retain and price provider-prefixed Bedrock Claude IDs (#743).
- v18.0.10: parse Claude fast mode and apply the model-specific multiplier (#886).
- v19.0.0: choose the richest duplicate snapshot and support missing request IDs (#984/#985).
- v20.0.5: suppress sidechain replays and normalize newer Claude/OpenRouter aliases (#1155/#1154).
- v20.0.6: Opus 4.8 rates and numeric-version boundary behavior (#1182).
- v20.0.8: duration-specific cache writes and free GLM cache creation (#1221/#1235).
- v20.0.15: explicit long-context thresholds become whole-request tier switches (#1414).
- v20.0.17: count advisor-model iterations (#1423).
- v20.0.20: include all fresh, cached-read, and cached-write prompt tokens in tier selection (#1541).

## Coverage that already existed before this fix

- The original “first duplicate wins” undercount from #984 was partly fixed: local code already kept a later snapshot when `output_tokens` grew.
- Missing-`requestId` deduplication from #985 already passed because local code had a message-only fallback.
- Local-time daily grouping is already implemented.
- OpenRouter dotted Claude IDs and current Bedrock version/geography aliases are normalized locally. Synthetic Opus 4.7 variants match v20.0.20, and `4.70` remains unpriced rather than incorrectly falling back to `4.7`.
- Opus 4.8 base/cache rates and its 2x fast multiplier are present.
- Explicit whole-request cliffs for GPT/Grok already repriced all token buckets; the fix completes their threshold composition with cache writes.

## Not applicable or outside the calculation layer

- CLI rendering, terminal width/color, statusline, sorting, JSON formatting, live-mode refresh, and report-label changes do not alter session totals.
- File discovery changes for other adapters (Codex, Amp, OpenCode, Gemini, etc.) are outside this Claude-shaped JSONL loader. Their provider-specific token schemas should not be ported blindly.
- The v20.0.0 nested `progress` versus direct-subagent equal-cost tie does not reach the local dedupe path: local code ignores the nested progress shape and counts the direct subagent row. A missing direct copy remains a separate parser-coverage risk.
- The v19.0.3 `gpt-5.4-mini` fuzzy-match fix differs locally, but that ID is absent from every shipped catalog. Local behavior is zero cost plus `priceMissing`, so this is a low-reach unsupported-model gap rather than the upstream overcharge.
- CCUsage issue #866 concerns unreliable placeholder counts emitted by Claude Code itself, not a calculation fix.
- Daily timezone attribution affects which day owns a cost, not the session's total cost.

## Remaining local risks outside these fixes

- Recorded `costUSD` is computed by the separate platform proxy, whose `apps/proxy/src/model-pricing.json` and `computeCost` must be kept in sync with this fallback table. As of 2026-08-21, platform `main` already has Opus 5's corrected $5/$25 base and 2x fast rates, but still prices Sonnet 5 at the cancelled $3/$15 rate; that requires a cross-repository follow-up. Historical Opus 4.6/4.7 fast rows in local transcripts should not be copied blindly into live-serving tiers.
- Rows without `costUSD` are priced through the currently selected global provider and its current user catalog. Changing providers or catalog overrides can therefore reprice historical bare-model rows.
- The `since` optimization first filters whole files by mtime. A restored/copied JSONL file with an old mtime but recent row timestamps can be missed. This is file discovery, not calculation.
- Both implementations currently ignore `inference_geo` and `server_tool_use` charges. These are shared blind spots rather than regressions fixed upstream.

The checked-in JSONL fixtures already contain `cache_creation`, `iterations`, `speed`, `service_tier`, `inference_geo`, and `server_tool_use`, so these are live transcript fields. Existing fixtures happen to have only ordinary iterations and zero 1h cache writes, which explains why the prior parity tests remained green.

## Reproduction commands

Full usage-service verification:

```sh
npx vitest run src/shared/lib/services/usage-service.test.ts \
  src/shared/lib/services/usage-service.ccusage-regressions.test.ts
```

Result after fixes: 133 passed.

Focused CCUsage regressions:

```sh
npx vitest run src/shared/lib/services/usage-service.ccusage-regressions.test.ts
```

Pre-fix result: 12 original failures. Final expanded result: 31 passed.
