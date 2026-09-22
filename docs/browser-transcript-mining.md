# Mining web-browser transcripts for harness friction

A repeatable process for turning a dump of `web-browser` subagent transcripts into a
ranked list of harness bugs and optimization opportunities, at a token cost that lets
us re-run it on every new dump.

Prototype scripts and the first run's outputs live in the session scratchpad
(`stats.py`, `stats2.py`, `compact.py`, `by_era.py`, `traces/`, `sessions.jsonl`).
The production version belongs in `scripts/browser-mining/` (TypeScript, Zod at every
file boundary, mirroring `scripts/label-scopes.workflow.js` + `audit-scope-labels.ts`).

## 1. What the data is

| | |
|---|---|
| Sessions | 1,188 jsonl files (README says 1,191; 3 are empty), 52 hosts, 153 agents |
| Size | 1.8 GB raw, p50 600 KB, p90 4 MB, max 36 MB per file |
| Span | 2026-03 → 2026-09; 249 sessions predate the 2026-06-12 browser audit fixes, 939 postdate them |
| Tool calls | 43,237 total; p50 19 per session, p90 87, max 584 |
| Hard errors | 3,780 (8.7% of calls); ~37% are infra (browser lock, daemon, Browserbase 402/410), not harness UX |
| Models | Sonnet 5 50%, Sonnet 4.6 17%, Opus 4.8 16%, Opus 4.7 14%, plus a few Grok/GPT |
| Screenshots | 7,044 images embedded as base64 in tool results (most of the bytes) |

Each line is a Claude Code transcript record. The useful fields per line:
`type` (`user`|`assistant`), `message.content[]` (`text`, `tool_use{name,input}`,
`tool_result{tool_use_id,is_error,content}`), `message.usage` (cache read/create,
output tokens), `timestamp`, `message.model`, `version`. Tool names are
`mcp__browser__browser_*`, plus `WebSearch`, `Read`, `request_browser_input`.

The manifest gives per-session `description` (the parent's one-line task label),
`host`, `agent`, `session_id`. First user line is the full delegated task; last
assistant text is the report back to the parent.

## 2. Why deterministic first: the signals are already in the data

A pure-Python pass over 1.8 GB takes ~2 min and already surfaces the shape of the
problem. Highlights from the first run (post-audit sessions unless noted):

**Escape hatches are 24% of all calls.** `browser_run` (5,918) + `browser_eval` (4,385)
= 10,303 of 43,237. The `browser_run` subcommand histogram is a direct "missing tool"
list: `eval` 1,966, `get url` 1,222, `tab` 555, `mouse` 450, `wait <ms>` 310, `reload`
192, `find text … click` 95, `network` 80, `console` 68, `back` 56, `scrollintoview` 53.

**Stale refs are the top harness-attributable error and rising.** `Unknown ref: eN`:
14 events in Mar–May, 60 in Jun–Jul, 291 in Aug–Sep (113 of 620 sessions, 18%).

**Polling by snapshot.** 568 consecutive identical `browser_snapshot` calls, 220
identical `browser_open`, 141 identical `browser_press`. Agents are using snapshot as a
"wait for the page to change" primitive because `browser_wait` is CSS-selector-only and
times out 25 s later (144 timeouts, 51 sessions in Aug–Sep).

**Snapshot insufficient.** 491 snapshot→screenshot pairs, 319 snapshot→eval. The
"covered by <element>" click error grew from 0 to 138 events / 76 sessions.

**A misleading hint fires ~1,000 times.** `browser_eval` appends
`(note: ran in a fresh function scope — add \`return\` …)` whenever the script was
wrapped, including when a value did come back (965 results across 198 sessions;
`agent-container/src/tools/browser.ts:568`). Trivial fix, real noise.

**Already fixed, and the data proves it.** `Browser is owned by session`: 929 events
before 2026-06-15 (one Sonnet 4.6 session retried it 494 times), 35 after, 2 in Aug–Sep.
That is the lock fix in commit 62663ca5. Era-splitting is mandatory or the top theme
would be a ghost.

**Agent-language signals.** In assistant text: "let me try" 981, "instead" 328,
"different approach" 156, "try a different" 117, "use javascript" 58, "stale" 85,
"truncated" 83, "captcha" 174, "cloudflare" 84.

**Compaction works.** Collapsing each session to a one-line-per-call trace (tool, brief
input, brief/classified result, Δt, snapshot size + similarity to previous snapshot,
assistant text truncated to 240 chars, heuristic flags) takes 1,824 MB → 10.7 MB
(171×). p50 trace ≈ 1.4k tokens, p90 ≈ 5k, whole corpus ≈ 2.7M tokens.

## 3. The pipeline

```
raw jsonl ──► [0] ETL ──► calls.jsonl + sessions.jsonl + traces/*.txt + rendered/*.json
                 │
                 ▼
            [1] detectors (regex/sequence rules) ──► findings.jsonl + prevalence table
                 │                                      (zero LLM tokens; this is
                 │                                       already a ranked theme list)
                 ├──────────────────────────────┐
                 ▼                              ▼
   [2A] DISCOVERY: Opus 5 reads       [2B] MEASUREMENT: Sonnet 5 classifies
        ~200 whole sessions as-is          every compact trace → strict JSON
        (snapshots, screenshots,           (outcome, wasted steps, category
        reasoning), open rubric,            counts using the current taxonomy)
        free-text findings first
                 │                              │
                 └──────────────┬───────────────┘
                                ▼
            [3] cluster + synthesize (Opus 5) ──► themes.md with exemplars + $ wasted
                 │                                 new themes → new detectors for [1]
                 ▼
            [4] per-theme deep dive (Opus 5 / Fable): raw exemplars + harness code
                 │   ──► root cause, proposed change, repro, Linear issue
                 ▼
            [5] ship fix ──► re-run [0]–[1] on the next dump ──► did the metric move?
```

### Stage 0: ETL (deterministic, TypeScript + Zod)

Input: the zip. Output, all Zod-validated on write and read:

- `sessions.jsonl` — one row per session: host, agent, model, era (pre/post audit
  commit dates), task (first user msg), final report, counts (tools, errors,
  infra errors, evals, runs, snapshots, screenshots), duration, output tokens, cache
  read tokens, friction score.
- `calls.jsonl` — one row per tool call: session, index, tool, brief input, Δt from
  previous call, result class (`ok` | `error:<taxonomy>` | `warn`), result length,
  image count, snapshot stats (lines, refs, similarity to previous snapshot), the set
  of refs visible in the last snapshot, and whether this call's `ref` was in it.
- `traces/<agent>.txt` — the human/LLM-readable compact trace (format in §2).

Design rules that matter:

- **Error taxonomy is a regex table, not free text.** Normalize `eN`, session ids,
  CDP URLs, then map to ~30 classes (`stale_ref`, `wait_timeout`, `covered_by`,
  `eval_syntax`, `dialog_probe`, `select_no_commit`, `upload_no_change`,
  `infra:lock`, `infra:daemon`, `infra:browserbase`, `user:rejected`, …). Unmatched
  errors go to `other` and the top-N of `other` is printed every run so the table
  grows.
- **Era tag from git.** Map session `t0` to the harness commits that shipped before it
  (`git log --date` on `agent-container/src/{tools/browser.ts,browser-digest.ts,
  snapshot-format.ts,select-verify.ts,eval-script.ts,tab-manager.ts,
  web-browser-agent-prompt.md}`). Every prevalence number is reported per era.
- **Screenshots stay out of the traces.** `traces/` keeps only "image present" and its
  size. The pixels are kept for lane A: `rendered/<agent>.json` is the session as an
  API-ready message (text blocks with turn markers, `image` blocks where screenshots
  occurred), which is what the discovery reviewer and any deep dive consume.
- **Cost attribution is measurable.** Every assistant turn carries `usage`, so a
  detector that marks steps 12–19 as "wasted on a stale-ref retry loop" can sum the
  output tokens and cache-creation tokens of those turns. Report wasted $ per theme,
  not just counts.

### Stage 1: Detectors (deterministic)

Each detector is a pure function `(calls of one session) → finding[]` with
`{session, step_range, pattern, evidence, wasted_turns}`. Initial set, all grounded in
the first run:

| Detector | Rule | What it indicates |
|---|---|---|
| `stale_ref` | `Unknown ref` error, or a ref used that was not in the last snapshot | ref stability / need auto-resnapshot-on-miss |
| `poll_by_snapshot` | ≥2 identical consecutive `snapshot`/`get_state` within 60 s, or `sim-to-prev > 0.98` | missing "wait for change" primitive |
| `snapshot_insufficient` | snapshot → screenshot or eval within one step, no intervening action | a11y tree lacks needed info (canvas, unnamed buttons, `generic clickable`) |
| `escape_hatch` | any `browser_run`; bucket by subcommand | tool gap (tab, mouse, url, wait-ms, find-text, back, reload) |
| `eval_for_interaction` | `browser_eval` containing `.click()`, `.value =`, `dispatchEvent`, `scrollTop` | structured action failed and the agent went around it |
| `eval_for_extraction` | `browser_eval` returning JSON > 1 KB | snapshot dropped text the task needed (`fullText` discoverability, or a real extraction tool) |
| `click_no_effect` | click → observation with `sim-to-prev > 0.98` → click again or workaround text | silent no-op clicks (overlay, hydration, wrong target) |
| `covered_by` | the covered-by error; extract the covering element | cookie banners, sticky footers, modals; candidate for auto-dismiss or auto-scroll |
| `wait_timeout` | `browser_wait` error; record the selector | selector-wait mismatch; agents want time/URL/text waits |
| `dialog_probe` | `scope=dialog`/`alertdialog` snapshot erroring | probing for a modal should return "none", not an error |
| `custom_widget` | `select reported success…`, phrases "dropdown", "date picker", "calendar" | non-native widgets need a recipe or a tool |
| `upload_failed` | upload change-event errors | React file inputs |
| `tab_churn` | tab warnings, `Cannot close the last tab`, ≥3 `tab` runs in 10 steps | tab management burden on the model |
| `misleading_hint` | harness note appended to a result that was actually fine | prompt/hint noise (the `return` note) |
| `large_output` | snapshot > 25k chars, `[snapshot truncated]`, get_state > 40k | context blowups |
| `blocked_external` | captcha / cloudflare / press-and-hold / login phrases, `request_browser_input` outcomes | product-level, tracked separately from harness UX |
| `infra` | lock / daemon / Browserbase / Chrome exit | reported, excluded from the friction score |
| `outcome` | final text classified success / partial / blocked / gave-up by regex (LLM refines in stage 2) | denominator for everything above |

Output of stage 1 alone is a prevalence table per era (events, sessions affected,
wasted turns, wasted output tokens) plus, per pattern, the 5 highest-impact exemplar
sessions with step ranges. This is the artifact that gets reviewed first; stage 2 only
runs on what stage 1 cannot explain.

### Stage 2: Two LLM lanes — discovery (Opus 5, full sessions) and measurement (Sonnet 5, traces)

The deterministic detectors only find what we already know to look for, and a
classification pass over a compact trace is not where new categories of friction will
surface. So stage 2 is two lanes with different jobs:

**Lane A — Discovery: Opus 5 reads whole sessions, as-is.** This is the pass that is
allowed to be creative. The reviewer sees the same thing the agent saw: every snapshot
in full, every tool result, every screenshot as an image, every piece of the agent's
own reasoning. The rubric is open-ended and written from the harness engineer's chair:

> You are the engineer who owns this browser harness. Walk the session. Every time
> the agent spent a step it would not have needed with a better harness, say what it
> wanted, what it got, what it did instead, and what single change to the tools,
> their output, or the prompt would have made it one step. Also flag: anything the
> harness said that was wrong or misleading; anything visible in the screenshot that
> the snapshot did not convey; any place the agent trusted a result it should not
> have; anything the prompt told it to do that cost time. Name what surprised you.

The output is free-form findings first, then a structured list (same shape as lane
B) so the two lanes can be merged in stage 3. Free text comes first on purpose: the
structured list is a projection of it, not a substitute.

Input rendering: not the raw jsonl. A ~100-line ETL step renders each session as a
single user turn with interleaved blocks — a `text` block per assistant turn and tool
call/result with `[#12 assistant]` / `[#12 tool_use browser_click]` / `[#12 result]`
markers, and an `image` block wherever a screenshot appeared. Base64 screenshots are
passed as image blocks (roughly 1.5k tokens each), never as text. The system prompt the
agent ran under is included once at the top so the reviewer can judge the prompt too.

Sizes (post-audit, ≥8 turns, 838 sessions): text p50 14k tokens, p90 50k, max 470k;
images p50 3, p90 16, max 99. Every session fits a single Opus 5 call.

Sampling for lane A: the point is to see what the detectors cannot, so do not pick
only by detector score. Three strata of equal size:
- highest detector density (known friction, want the nuance around it),
- uniformly random among post-audit sessions (what "normal" costs),
- long sessions with few detector hits (≥40 tool calls, friction score below median —
  silent inefficiency the rules miss).

Budget: ~200 sessions is ~$50 via the Batch API with images; the entire post-audit
corpus is ~$100 via Batch (~$200 at list price). Start with 200, and if stage 3 is
still finding new categories in the last 50, run the rest.

**Lane B — Measurement: Sonnet 5 classifies compact traces.** Every post-audit
session, compact trace (p90 5k tokens) plus a closed rubric, returning strict JSON:

```json
{
  "outcome": "success|partial|blocked_external|blocked_harness|gave_up",
  "steps_total": 87,
  "steps_wasted": 23,
  "friction": [
    {
      "steps": "12-19",
      "category": "stale_ref|poll_by_snapshot|…|other",
      "agent_wanted": "click the second search result",
      "harness_gave": "Unknown ref e31 after the page re-rendered",
      "workaround": "eval querySelector(...).click()",
      "one_step_fix": "snapshot digest should re-resolve refs by role+name",
      "confidence": 0.8
    }
  ],
  "blocked_by_site": ["captcha"],
  "notes": "…"
}
```

The category list for lane B is seeded from the detectors and extended with whatever
lane A discovers, so on the second run lane B can count the new categories across the
whole corpus. This lane exists to give prevalence and outcome labels, not insight;
Sonnet 5 at $2/$10 per MTok is right for it, about $17 for the corpus, half via Batch.

Execution for both lanes: **Message Batches API** (50% discount, async) via a TS
script (`@anthropic-ai/sdk`, `client.messages.batches`, `output_config.format` for
the structured part, `custom_id = agent id`). A Claude Code Workflow is the fallback
for a small lane A sample (~15 agents, one session each), but for hundreds of
independent calls the Batch API is the right tool and does not tie up the session.

### Stage 3: Cluster and synthesize (Opus 5, one agent)

Input: `findings.jsonl` from stage 1, lane A free-text findings, lane B JSON. Start
from lane A: read all its findings, propose themes, then use lane B counts and stage 1
prevalence to size them. For each theme: sessions affected, events, wasted turns,
wasted output tokens × model price, 3–5 exemplars with trace paths and step ranges,
the harness file/line most likely responsible (from the code map in §5), and a proposed
change. Output: `themes.md`, ordered by wasted $ per era, with a separate "new since
last run" section (themes no detector covers yet) and a "not harness" section (captcha,
login, Browserbase billing) so product sees it too. Every new theme gets a detector
in stage 1 before the next run.

### Stage 4: Per-theme deep dive (Opus 5 or Fable, one agent per theme)

Only now does a model read raw jsonl: 3–5 exemplar sessions in full (real snapshots,
real screenshots when needed) plus the relevant harness source. Deliverable per theme:
confirmed root cause, a minimal repro (Playwright test against a fixture page, or a
scripted re-run against the live site), the concrete change, and a Linear issue body.
Budget ~150k tokens per theme; cap at the top 8–10 themes per run.

### Stage 5: Close the loop

Stages 0–1 are the regression suite. After a fix ships, the next dump answers "did
`stale_ref` events per 100 calls go down?" without any LLM tokens. Suggested KPIs,
all per era and per model:

- escape-hatch rate (`run`+`eval` / all calls)
- stale-ref rate, poll-by-snapshot rate, covered-by rate
- tool calls per completed task (outcome = success), median and p90
- output tokens per completed task
- share of sessions with any harness-attributable friction

## 4. Token and cost budget

| Stage | Tokens | Model | Cost (list / via Batch API) |
|---|---|---|---|
| 0–1 ETL + detectors | 0 | – | ~2 min CPU |
| 2A discovery, 200 whole sessions with screenshots | ~6.5M in / 0.6M out | Opus 5 | ~$50 / ~$25 |
| 2A discovery, all 838 post-audit sessions | ~27.6M in / 2.5M out | Opus 5 | ~$200 / ~$100 |
| 2B measurement, all 939 post-audit traces | ~2.5M in / 1.2M out | Sonnet 5 | ~$17 / ~$9 |
| 3 synthesis | ~500k in / 50k out | Opus 5 | ~$4 |
| 4 deep dives, 8 themes | ~1.2M in / 150k out | Opus 5 | ~$10 |
| **First full run (200-session discovery)** | **~12M** | | **~$80 list, ~$50 via Batch** |
| **First full run (whole-corpus discovery)** | **~35M** | | **~$230 list, ~$125 via Batch** |

The corpus is small enough that cost is not the constraint; wall-clock and reviewer
attention are. Discovery is where the money should go: the deterministic funnel and the
Sonnet lane earn their keep by making results comparable across runs and by producing
exemplar pointers a human can open in seconds, not by finding new things.

## 5. Where the harness lives (for stage 4 and for wiring detectors to code)

- Tool definitions the model sees: `agent-container/src/tools/browser.ts` (17 tools;
  `browser_run` is the raw `agent-browser` CLI passthrough at line 578, `browser_eval`
  at 552, `browser_get_state` at 635).
- HTTP endpoints: `agent-container/src/server.ts` from line 752 (`snapshot` 1424,
  `click` 1492, `wait` 1610, `run` 1950).
- Snapshot post-processing: `agent-container/src/snapshot-format.ts` (45k soft cap,
  cross-origin iframe placeholders, no shadow DOM handling).
- Post-action digests and settle delays: `agent-container/src/browser-digest.ts`.
- Select verification, press-key validation, eval wrapping:
  `select-verify.ts`, `press-key.ts`, `eval-script.ts`.
- Tab limits and warnings: `agent-container/src/tab-manager.ts`.
- Subagent prompt: `agent-container/src/web-browser-agent-prompt.md`; model-facing
  guide: `agent-container/docs/browser-use.md`.
- Engine: `agent-browser@0.27.2` (Rust CLI, `Dockerfile:97`), Chromium headless shell.
  Refs renumber after navigation/selection (upstream vercel-labs/agent-browser#1443).
- Browser lock: `agent-container/src/browser-state.ts:32`.

## 6. Candidate themes already visible (to be confirmed by stages 2–4)

Ordered by a first estimate of impact in the Aug–Sep era:

1. **Ref staleness** — 291 `Unknown ref` events / 113 sessions, plus refs used that
   were absent from the last snapshot. Options: re-resolve by role+name on miss, or
   auto-resnapshot and return the fresh tree with the error.
2. **No "wait for change" primitive** — 568 identical-snapshot polls, 144 wait
   timeouts, 310 `run wait <ms>`. A `browser_wait` that accepts `url_changes`,
   `text`, `network_idle`, `ms` would remove most of these.
3. **`get url` as a separate call** — 1,222 calls. Put the URL in the header of every
   snapshot and digest (get_state already does).
4. **Clicks blocked by overlays** — 138 covered-by events / 76 sessions. Report the
   covering element's ref (often a cookie banner) and offer a one-shot dismiss.
5. **Tab management via raw CLI** — 555 `run tab` calls plus warning spam. A
   `browser_tabs` tool (list/switch/close) would replace the mandatory prompt section.
6. **Coordinate clicks** — 450 `run mouse`, 13 `mouse click` misuse errors, the canvas /
   Figma sessions. `browser_click` accepting `{x,y}` closes this.
7. **Misleading eval hint** — 965 results; one-line fix at `tools/browser.ts:568`.
8. **Dialog probing errors** — 40 sessions probe `scope=dialog` and get an error when
   none exists; return an empty result instead.
9. **Snapshot text loss** — 319 snapshot→eval and the extraction-style evals
   (product grids, listing cards). Either make `fullText` discoverable in the digest
   when the tree is mostly `generic`, or add a scoped text-extraction tool.
10. **Upload on React inputs** — 29 change-event failures / 13 sessions, all Aug–Sep.

## 7. Rollout

1. Port stage 0–1 to `scripts/browser-mining/` (TS, Zod schemas in
   `transcript-schema.ts`, `findings-schema.ts`), add the session renderer for lane A,
   commit the error taxonomy table, and check in the prevalence table from this dump
   as the baseline.
2. Run lane A on 200 sessions via the Batch API (~$25–50). Read the free-text findings
   before anything else; this is the pass most likely to change the theme list.
3. Fix theme 7 and ship theme 3 (both tiny) so the next dump shows the pipeline
   detecting a change.
4. Run lane B on the full post-audit corpus with the taxonomy extended by lane A;
   synthesize `themes.md`.
5. Deep-dive the top 5; open Linear issues with exemplar trace paths.
6. Schedule the dump + stages 0–1 monthly; lane A on a fresh 100-session sample each
   time; compare KPIs per era.

## 8. First Lane A run (2026-09-10)

Ran as two Claude Code workflows with Opus 5 subagents at list price: 80 review agents
(200 sessions, 16.7M tokens, 52 min) and 14 synthesis agents (2.5M tokens, 50 min).

- Sample: 200 post-audit sessions with ≥8 calls, infra-dominated excluded; strata of
  67 high-friction, 66 long-low-friction, 67 random.
- Output: 1,811 findings, 200 free-text findings files, 51 merged themes. Report:
  [browser-harness-friction-themes-2026-09.md](browser-harness-friction-themes-2026-09.md).
- Reviewer-estimated waste: 41% of calls in the high-friction stratum, 32% in
  long-low-friction, 31% in random. Waste is similar across models (35–51%).
- The long-low-friction stratum produced as many snapshot-content findings as the
  high-friction one, confirming the detectors missed a large class of silent cost.
- Top five changes by sessions affected: page text primitive (142/200), page identity
  and readiness on every result (130), action digest carrying the DOM effect (118),
  eval wrapper fixes (112), layer-aware tree (97).
- 32 new detectors proposed in the report's final section; these become stage 1 rules
  before the next dump.

Raw artifacts (session scratchpad, not committed): `laneA/findings/<agent>.md`,
`laneA/themes/<area>.md`, `laneA/results.json`, `laneA/rendered/<agent>/`.
