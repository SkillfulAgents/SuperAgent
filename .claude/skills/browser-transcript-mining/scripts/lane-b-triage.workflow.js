/**
 * lane-b-triage workflow (MEASUREMENT lane)
 * ──────────────────────────────────────────
 * Classifies every compact trace (traces/<agent>.txt from compact.py) against a
 * closed friction taxonomy and returns strict JSON per session. This lane exists
 * for prevalence and outcome labels across the whole corpus, not for discovery —
 * run lane A (lane-a-review.workflow.js) first and extend `taxonomy` with what it
 * finds, so this pass can count the new categories everywhere.
 *
 * Runs via the Workflow tool. Args:
 *   { tracesDir: string,               // .../traces
 *     agents: string[],                // agent ids to classify (post-audit, >= 8 calls)
 *     outDir: string,                  // where each agent writes laneB/<batch>.json
 *     taxonomy: string,                // comma-separated category names with one-line definitions
 *     perAgent?: number }              // traces per subagent (default 10, ~50k tokens)
 *
 * NOTE: this script was authored alongside the first lane A run and has not been
 * exercised end to end yet. Expect to adjust the prompt on first use.
 */

export const meta = {
  name: 'browser-harness-lane-b',
  description: 'Lane B measurement: Sonnet classifies compact web-browser traces against the friction taxonomy',
  phases: [{ title: 'Classify', detail: 'batches of ~10 compact traces per Sonnet agent → strict JSON per session', model: 'sonnet' }],
}

const SCHEMA = {
  type: 'object',
  properties: {
    sessions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          outcome: { type: 'string', enum: ['success', 'partial', 'blocked_external', 'blocked_harness', 'gave_up', 'unclear'] },
          steps_total: { type: 'number' },
          steps_wasted: { type: 'number' },
          friction: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                steps: { type: 'string' },
                category: { type: 'string', description: 'one of the taxonomy names, or "other"' },
                agent_wanted: { type: 'string' },
                harness_gave: { type: 'string' },
                workaround: { type: 'string' },
                one_step_fix: { type: 'string' },
                confidence: { type: 'number' },
              },
              required: ['steps', 'category', 'agent_wanted', 'harness_gave', 'workaround', 'one_step_fix', 'confidence'],
            },
          },
          blocked_by_site: { type: 'array', items: { type: 'string' } },
          notes: { type: 'string' },
        },
        required: ['agent', 'outcome', 'steps_total', 'steps_wasted', 'friction', 'blocked_by_site', 'notes'],
      },
    },
  },
  required: ['sessions'],
}

const per = args.perAgent || 10
const batches = []
for (let i = 0; i < args.agents.length; i += per) batches.push([batches.length + 1, args.agents.slice(i, i + per)])
log(`Lane B: ${args.agents.length} traces in ${batches.length} batches`)

phase('Classify')
const results = await pipeline(batches, ([id, agents]) => agent(
  `You are classifying compact traces of a browser-automation subagent against a fixed taxonomy of harness friction. Each trace is one line per tool call: "#n +Δt tool(brief input)" followed by "<- result summary" (ERR marks a hard error; snapshot results are summarized as line/ref counts with similarity to the previous snapshot; assistant text is truncated to 240 chars and flagged [WORKAROUND?] / [BLOCKER?] by regex).

Taxonomy (use exactly these names, or "other"):
${args.taxonomy}

Traces for this batch (read each file in full):
${agents.map(a => `- ${args.tracesDir}/${a}.txt`).join('\n')}

For each session: decide the outcome from the final assistant text; count steps_total (tool calls); estimate steps_wasted (calls a better harness would have made unnecessary); list every friction event with its step range, taxonomy category, what the agent wanted, what the harness gave, the workaround, and the one-step fix. Keep site-side blockers (captcha, login, bot check, billing) in blocked_by_site, not in friction. Infra errors (browser lock, daemon, Browserbase 402/410) are not friction. Do not pad: a clean session has an empty friction list.

Write the JSON you return to ${args.outDir}/batch-${id}.json as well, then return it.`,
  { label: `batch ${id} (${agents.length})`, phase: 'Classify', model: 'sonnet', effort: 'medium', schema: SCHEMA }))
const sessions = results.filter(Boolean).flatMap(r => r.sessions)
const missing = batches.filter((b, i) => !results[i]).map(b => b[0])
if (missing.length) log(`batches with no result: ${missing.join(', ')}`)
log(`classified ${sessions.length}/${args.agents.length} sessions`)
return { sessions, missingBatches: missing }
