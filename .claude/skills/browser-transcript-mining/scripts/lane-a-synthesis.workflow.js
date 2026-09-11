/**
 * lane-a-synthesis workflow
 * ─────────────────────────
 * Phase 1: one Opus agent per finding area clusters laneA/by_area/<area>.json
 * (written by lane_a_aggregate.py) into themes and writes laneA/themes/<area>.md.
 * Phase 2: one merge agent dedups across areas, ranks by sessions × severity and
 * writes laneA/themes.md. Runs via the Workflow tool.
 *
 * Args (lane_a_prep.py writes them to laneA/synthesis-args.json):
 *   { base: string, repo: string, areas: string[], knownDetectors: string }
 */
export const meta = {
  name: 'browser-harness-lane-a-synthesis',
  description: 'Cluster 1,811 Lane A findings into harness themes per area, then merge and rank into themes.md',
  phases: [
    { title: 'Cluster', detail: 'one agent per finding area (10) + misleading/gaps/surprises (3)', model: 'opus' },
    { title: 'Merge', detail: 'one agent merges, dedups across areas, ranks, writes themes.md', model: 'opus' },
  ],
}

const BASE = args.base
const REPO = args.repo
const KNOWN = args.knownDetectors

const THEME_SCHEMA = {
  type: 'object',
  properties: {
    themes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: 'string', description: '2-4 sentences: the mechanism, in harness terms' },
          sessions: { type: 'array', items: { type: 'string' }, description: 'distinct agent ids' },
          findings_count: { type: 'number' },
          wasted_calls: { type: 'number', description: 'sum of wasted_calls across the findings in this theme' },
          max_severity: { type: 'number' },
          exemplars: { type: 'array', items: { type: 'object', properties: { agent: { type: 'string' }, steps: { type: 'string' }, quote: { type: 'string' } }, required: ['agent', 'steps', 'quote'] } },
          proposed_fix: { type: 'string', description: 'the concrete harness change (tool, output, prompt), as specific as the findings allow' },
          harness_location: { type: 'string', description: 'file(s) in agent-container/src most likely responsible; empty if unknown' },
          novelty: { type: 'string', enum: ['covered_by_known_detector', 'variant_of_known', 'new'] },
          measurement_hook: { type: 'string', description: 'how a deterministic detector over the call log could count this' },
        },
        required: ['name', 'description', 'sessions', 'findings_count', 'wasted_calls', 'max_severity', 'exemplars', 'proposed_fix', 'harness_location', 'novelty', 'measurement_hook'],
      },
    },
    unclustered: { type: 'array', items: { type: 'string' }, description: 'one-line notes for findings that fit no theme but seem real' },
  },
  required: ['themes', 'unclustered'],
}

function clusterPrompt(area, file, note) {
  return `You are synthesizing the output of a review in which Opus read 200 production sessions of this repo's "web-browser" subagent and recorded every place the browser harness cost the agent steps. Your slice: findings in the area "${area}".

Read ${file} — a JSON array of findings; each has agent (session id), stratum, model, title, steps (call numbers), agent_wanted, harness_gave, workaround, one_step_fix, wasted_calls, severity (1-5), confidence (0-1). ${note}

Ground yourself in the harness first: skim ${REPO}/agent-container/src/tools/browser.ts (tool definitions and the text the model sees), ${REPO}/agent-container/src/browser-digest.ts (post-action digests), ${REPO}/agent-container/src/snapshot-format.ts, and ${REPO}/agent-container/src/web-browser-agent-prompt.md. Grep further under ${REPO}/agent-container/src when a theme points at a specific behavior, so harness_location is a real file.

Cluster the findings into themes by MECHANISM (what the harness did or failed to do), not by symptom or by site. A theme should be something one engineer could fix with one change. Split a theme if its findings imply different fixes; merge themes if they imply the same fix. Keep low-confidence (<0.5) findings out of counts unless corroborated. For each theme compute sessions (distinct agent ids), findings_count, wasted_calls (sum), max_severity, and pick 3-5 exemplars whose quote is a short verbatim phrase from harness_gave or workaround plus the agent id and steps. Judge novelty against these detectors that already exist in the deterministic pass: ${KNOWN}. Write the measurement_hook as a rule over the call log (tool names, inputs, result text patterns, sequence).

Also Write a readable version to ${BASE}/themes/${area}.md (theme per section, same content), then return the structured result. Be exhaustive: every finding with confidence >= 0.5 should land in a theme or in unclustered.`
}

phase('Cluster')
const slices = args.areas.map(a => [a, `${BASE}/by_area/${a}.json`, ''])
slices.push(['misleading_harness_output', `${BASE}/by_area/_misleading_gaps_surprises.json`, 'This file is a JSON array of [kind, agent, text] triples; use ONLY entries with kind "misleading" (statements the harness made that were wrong, stale, or noise). Treat each as a finding with severity 3 and wasted_calls 1 unless the text says otherwise.'])
slices.push(['snapshot_vs_screenshot_gaps', `${BASE}/by_area/_misleading_gaps_surprises.json`, 'This file is a JSON array of [kind, agent, text] triples; use ONLY entries with kind "gap" (things visible in a screenshot that the accessibility snapshot did not convey). Treat each as a finding with severity 3 and wasted_calls 1 unless the text says otherwise. Cluster by what kind of content/state the snapshot dropped and why (unnamed controls, static text, canvas, state attributes, overlays, loading, layout).'])
slices.push(['surprises', `${BASE}/by_area/_misleading_gaps_surprises.json`, 'This file is a JSON array of [kind, agent, text] triples; use ONLY entries with kind "surprise" (free-text observations the reviewer could not classify). These are the most likely place for genuinely new themes; cluster loosely and mark novelty carefully. Treat each as severity 2, wasted_calls 0 unless the text says otherwise.'])
const clustered = await parallel(slices.map(([area, file, note]) => () =>
  agent(clusterPrompt(area, file, note), { label: `cluster ${area}`, phase: 'Cluster', model: 'opus', effort: 'high', schema: THEME_SCHEMA })
    .then(r => ({ area, ...r }))))
const ok = clustered.filter(Boolean)
log(`clustered ${ok.length}/${slices.length} slices, ${ok.reduce((n, c) => n + c.themes.length, 0)} themes`)

phase('Merge')
const mergePrompt = `You are producing the final synthesis of a harness-friction review: Opus read 200 production sessions of this repo's "web-browser" subagent (three strata: 67 highest-friction by deterministic detectors, 66 long sessions with few detector hits, 67 random; all after the 2026-06-12 harness audit) and recorded 1,811 findings. Per-area cluster agents have turned those into themes, written as markdown under ${BASE}/themes/*.md (one file per area: ${slices.map(s => s[0]).join(', ')}). Read every file in that directory in full.

Session-level facts you should use: reviewers judged 4,381 of 10,635 calls wasted in the high-friction stratum (41%), 1,686 of 5,260 (32%) in long-low-friction, 612 of 1,963 (31%) in random. Wasted-call sums per theme come from reviewer estimates and can double count across themes; treat them as relative weight, not accounting.

Do this:
1. Merge themes across areas that describe the same mechanism or imply the same fix (the same problem often appears under snapshot_content, action_result and error_message). Keep a note of which area-themes fed each merged theme.
2. Rank merged themes by (distinct sessions affected × max_severity), using wasted_calls as a tiebreaker. Show sessions affected out of 200.
3. For the top 25 themes write a section with: mechanism (2-5 sentences), evidence (3-5 verbatim exemplar quotes with agent id + call numbers, taken from the area files), the proposed harness change (be concrete: tool name, parameter, output text, prompt line), the likely file(s) in agent-container/src (verify with grep in ${REPO} where the area files disagree), novelty vs the existing detectors (${KNOWN}), and the measurement hook.
4. Then a table of ALL remaining merged themes (name, sessions, findings, wasted, severity, one-line fix).
5. Then short sections: "Prompt guidance that cost time" (rules in web-browser-agent-prompt.md / browser-use.md that the findings say were counterproductive or ignorable), "Things the harness got right" (behaviors reviewers praised, so nobody removes them), "Not harness" (site-side blockers, model-side mistakes), and "New detectors to add" (measurement hooks for every theme marked new or variant_of_known).
6. Open with an executive summary of at most 15 lines: the five changes that would remove the most waste, with the session counts.

Write the whole thing to ${BASE}/themes.md. Return as your final text a 30-line summary: the ranked top 15 theme names with sessions affected and the one-line fix each.`
const summary = await agent(mergePrompt, { label: 'merge + rank', phase: 'Merge', model: 'opus', effort: 'xhigh' })
return { summary, areaThemeCounts: ok.map(c => [c.area, c.themes.length, c.unclustered.length]) }