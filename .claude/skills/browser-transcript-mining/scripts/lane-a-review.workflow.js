/**
 * lane-a-review workflow (DISCOVERY lane)
 * ─────────────────────────────────────────
 * One Opus agent per batch reads whole rendered sessions (markdown parts +
 * screenshots produced by lane_a_prep.py), writes laneA/findings/<agent>.md and
 * returns structured findings. Runs via the Workflow tool.
 *
 * Args (lane_a_prep.py writes them to laneA/review-args.json):
 *   { base: string,                    // .../laneA
 *     repo: string,                    // repo root, for the harness prompt + tool definitions
 *     batches: [number, string[]][] }  // [batchId, agentIds]
 */
export const meta = {
  name: 'browser-harness-lane-a',
  description: 'Lane A discovery: Opus reads 200 whole web-browser sessions as-is and reports harness friction',
  phases: [
    { title: 'Review', detail: '80 batches of 1-6 rendered sessions; free-text findings per session + structured summary', model: 'opus' },
  ],
}

const BASE = args.base
const REPO = args.repo
const FINDINGS = `${BASE}/findings`

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
          steps_wasted: { type: 'number', description: 'tool calls that a better harness would have made unnecessary' },
          findings: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', description: 'short name for the friction, e.g. "stale ref after in-place re-render"' },
                steps: { type: 'string', description: 'call numbers involved, e.g. "12-19"' },
                area: { type: 'string', enum: ['tool_surface', 'snapshot_content', 'action_result', 'error_message', 'wait_timing', 'prompt_guidance', 'engine', 'tabs', 'auth_or_blocker', 'other'] },
                agent_wanted: { type: 'string' },
                harness_gave: { type: 'string' },
                workaround: { type: 'string' },
                one_step_fix: { type: 'string', description: 'the single harness change that would have made this one step' },
                wasted_calls: { type: 'number' },
                severity: { type: 'number', description: '1 minor .. 5 task-threatening' },
                confidence: { type: 'number', description: '0..1' },
              },
              required: ['title', 'steps', 'area', 'agent_wanted', 'harness_gave', 'workaround', 'one_step_fix', 'wasted_calls', 'severity', 'confidence'],
            },
          },
          misleading_harness_output: { type: 'array', items: { type: 'string' }, description: 'things the harness said that were wrong, stale, or noise' },
          snapshot_vs_screenshot_gaps: { type: 'array', items: { type: 'string' }, description: 'things visible in a screenshot that the accessibility snapshot did not convey' },
          surprises: { type: 'string', description: 'what surprised you about this session, free text' },
          findings_file: { type: 'string' },
        },
        required: ['agent', 'outcome', 'steps_total', 'steps_wasted', 'findings', 'misleading_harness_output', 'snapshot_vs_screenshot_gaps', 'surprises', 'findings_file'],
      },
    },
  },
  required: ['sessions'],
}

function prompt(batchId, agents) {
  const list = agents.map(a => `- ${a}: ${BASE}/rendered/${a}/ (read session.part01.md, part02, ... in order; screenshots in shots/)`).join('\n')
  return `You are the engineer who owns the browser-use harness in this repo (the "web-browser" subagent: its tools, the accessibility snapshot it returns, the post-action digests, the error messages, and its system prompt). You are reviewing real production sessions of that subagent to find where the HARNESS cost the agent steps, tokens, or correctness. The models are smart and find workarounds; every workaround is a cost we want to remove by making the harness more intuitive and robust. Your job is nuance and discovery, not classification: look for things nobody has a detector for yet.

## Ground yourself first (once)
Read, in this order, from ${REPO}:
1. agent-container/src/web-browser-agent-prompt.md   (the subagent's system prompt)
2. agent-container/docs/browser-use.md                (model-facing guidance)
3. agent-container/src/tools/browser.ts               (the 17 tool definitions and the text the model sees; skim the descriptions, do not study the implementation)
Note: sessions were recorded between 2026-06-15 and 2026-09-10; the prompt and tools evolved a little in that window, so judge what the agent actually saw in the transcript over what the files say today.

## Sessions in this batch (batch ${batchId})
${list}

Each session directory holds the full transcript rendered as markdown: the task, every assistant message, every tool call with its input, every tool result in full (the same text the model saw), and screenshots extracted as PNG files where the harness returned an image. Parts are at most 1200 lines; read every part of every session completely and in order (use Read's offset/limit if a part is long). Open screenshots with Read whenever a result was surprising, an action had no visible effect, an error occurred, the agent changed approach, or the agent relied on the image rather than the snapshot. If a session has 12 or fewer screenshots, open all of them.

## What to look for, per session
Walk the session call by call. Every time the agent spent a call it would not have needed with a better harness, record: what it wanted, what it got, what it did instead, and the single change to the tools, their output, or the prompt that would have made it one step. Beyond that, look specifically for:
- Anything the harness said that was wrong, stale, misleading, or noise (hints that did not apply, warnings that fired needlessly, digests that claimed something the screenshot contradicts).
- Anything visible in a screenshot that the accessibility snapshot did not convey (unnamed buttons, canvas, icon-only controls, layout, state like selected/disabled, overlays, loading spinners, error banners).
- Places the agent trusted a result it should not have, or distrusted one it should have.
- Places the agent guessed at timing (waited, re-snapshotted, retried) because nothing told it when the page was ready.
- Tool gaps: things done through browser_run or browser_eval that deserve a first-class tool, and things the agent could not do at all.
- Prompt guidance that cost time (mandatory rituals, tab rules, "always do X").
- Output that was too large, truncated, or mostly useless for the task.
- Anything that was the SITE's fault (captcha, login, bot check) — note it, but keep it separate from harness findings.
- What surprised you. Name it even if you cannot classify it.
Do not pad. A clean session with no harness friction is a valid result; say so and say what the harness did well, briefly.

## Output
For each session, Write a free-text findings file to ${FINDINGS}/<agent>.md with this skeleton:
  # <agent> — <task in one line>
  Outcome: ... | Calls: N | Wasted (est): N
  ## Walkthrough of friction (chronological; cite call numbers; be concrete and quote the harness text when it matters)
  ## Misleading or noisy harness output
  ## Snapshot vs screenshot gaps
  ## Tool gaps / prompt issues
  ## Site-side blockers (not harness)
  ## What would have made this session shortest
  ## Surprises
Write the free text first; it is the primary deliverable. Then return the structured summary (StructuredOutput) with one entry per session; its findings are a projection of the file, set findings_file to the path you wrote. Include every session in the batch even if it had nothing to report.`
}

phase('Review')
const batches = args.batches
log(`Lane A: ${batches.length} batches, ${batches.reduce((n, b) => n + b[1].length, 0)} sessions`)
const results = await pipeline(
  batches,
  ([id, agents]) => agent(prompt(id, agents), { label: `batch ${id} (${agents.length})`, phase: 'Review', model: 'opus', effort: 'high', schema: SCHEMA }),
)
const ok = results.filter(Boolean)
const sessions = ok.flatMap(r => r.sessions)
const missing = batches.filter((b, i) => !results[i]).map(b => b[0])
if (missing.length) log(`batches with no result: ${missing.join(', ')}`)
log(`reviewed ${sessions.length} sessions, ${sessions.reduce((n, s) => n + s.findings.length, 0)} findings`)
return { sessions, missingBatches: missing }