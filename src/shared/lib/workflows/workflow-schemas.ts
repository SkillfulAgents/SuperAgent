import { z } from 'zod'

/**
 * Zod schemas for the on-disk artifacts of a Claude Agent SDK dynamic workflow
 * (`local_workflow`) and for the derived "workflow tree" the host serves to the
 * renderer.
 *
 * A workflow runs entirely inside the CLI subprocess; only workflow-level
 * lifecycle crosses the SDK stream. The per-agent tree (which agents ran, in
 * which phase, with what label/result) is reconstructed from three on-disk
 * sources under the agent workspace:
 *   - `subagents/workflows/<runId>/journal.jsonl`     — per-agent lifecycle (status source)
 *   - `subagents/workflows/<runId>/agent-<id>.jsonl`  — per-agent transcript (first user msg = the join key)
 *   - `workflows/scripts/<name>-<runId>.js`           — phase + label source (parsed, never eval'd)
 *
 * Per project rule, JSON read back from disk is `.parse()`d at the boundary and
 * the route response (a JSON-over-HTTP boundary) is validated too.
 */

/**
 * Stringify an agent's return value for display: strings pass through, structured
 * results (schema-mode agents return objects/arrays) are JSON-encoded, absent → null.
 * Shared by the journal tailer (live) and the tree builder (disk) so both render
 * results identically.
 */
export function displayAgentResult(r: unknown): string | null {
  if (r === undefined || r === null) return null
  if (typeof r === 'string') return r
  try {
    return JSON.stringify(r)
  } catch {
    return String(r)
  }
}

// --- journal.jsonl: one line per agent lifecycle transition ----------------

const JournalStartedLineSchema = z.object({
  type: z.literal('started'),
  key: z.string(),
  agentId: z.string(),
})

const JournalResultLineSchema = z.object({
  type: z.literal('result'),
  key: z.string(),
  agentId: z.string(),
  // The agent's return value. Usually a string, but schema-mode agents return
  // objects/arrays — keep it permissive at the boundary and stringify for display.
  result: z.unknown().optional(),
})

export const JournalLineSchema = z.discriminatedUnion('type', [
  JournalStartedLineSchema,
  JournalResultLineSchema,
])
export type JournalLine = z.infer<typeof JournalLineSchema>

// --- parsed workflow script (output of workflow-script-parser) -------------

export const WorkflowPhaseSchema = z.object({
  title: z.string(),
  detail: z.string().optional(),
})
export type WorkflowPhase = z.infer<typeof WorkflowPhaseSchema>

export const ParsedAgentCallSchema = z.object({
  /** The prompt arg converted to an anchored regex; each `${expr}` is a capture group. */
  promptRegexSource: z.string(),
  /** Source text of each `${expr}` in the prompt, positional (parallel to capture groups). */
  holeExprs: z.array(z.string()),
  /** `opts.label` source (may itself contain `${expr}`); null if absent. */
  labelTemplate: z.string().nullable(),
  /** Static `opts.phase` literal, if present. */
  phase: z.string().nullable(),
  /** Nearest preceding `phase('X')` call in source order. */
  sourcePhase: z.string().nullable(),
  /** Order of this `agent()` call in the script source. */
  sourceIndex: z.number().int(),
  /** True if this call sits inside a `parallel([...])` span. */
  inParallel: z.boolean(),
  /** `args` key this call fans out over (`args.<key>.map(...)` / `pipeline(args.<key>, ...)`),
   *  so the expected agent count can be sized from the invocation's actual array. */
  fanOutArgsKey: z.string().nullable(),
})
export type ParsedAgentCall = z.infer<typeof ParsedAgentCallSchema>

export const ParsedScriptSchema = z.object({
  name: z.string().nullable(),
  description: z.string().nullable(),
  phases: z.array(WorkflowPhaseSchema),
  agentCalls: z.array(ParsedAgentCallSchema),
})
export type ParsedScript = z.infer<typeof ParsedScriptSchema>

// --- workflow tree (host route response) -----------------------------------

export const WorkflowAgentNodeSchema = z.object({
  agentId: z.string(),
  /** Resolved display label, e.g. `word-alpha` or `fact:Mars`; falls back to `agent N`. */
  label: z.string(),
  phase: z.string().nullable(),
  // Disk (journal) only knows running/done; `failed` comes from the live wire snapshot.
  status: z.enum(['running', 'done', 'failed']),
  /** Display string of the agent's return value (JSON-stringified if structured). */
  result: z.string().nullable(),
  /** How the agentId→call join was made (for debuggability + tests). */
  resolved: z.enum(['prompt-regex', 'ordinal-fallback']),
  /** The prompt/task the agent started with (its first user message). */
  prompt: z.string(),
  /** Tool calls made so far (count of tool_use blocks in the transcript). */
  toolCount: z.number().int().nonnegative(),
  /** Output tokens the agent has generated so far (sum across assistant turns). */
  tokens: z.number().int().nonnegative(),
  /** Wall-clock span of the agent's transcript so far, or null if not derivable. */
  durationMs: z.number().int().nonnegative().nullable(),
})
export type WorkflowAgentNode = z.infer<typeof WorkflowAgentNodeSchema>

export const WorkflowTreeSchema = z.object({
  runId: z.string(),
  name: z.string().nullable(),
  description: z.string().nullable(),
  phases: z.array(WorkflowPhaseSchema),
  agents: z.array(WorkflowAgentNodeSchema),
  /** Estimated total agents: call sites that fan out over a Workflow `args` array
   *  count as that array's actual length (mined from the invocation's tool_use);
   *  every other call site counts as 1. Still a LOWER bound — fan-outs over
   *  runtime-computed collections can't be sized statically. Used to render
   *  not-yet-started agents as "pending" in the progress bar. */
  expectedAgents: z.number().int().nonnegative(),
  /** Workflow-wide rollups: summed tools/tokens, and the wall-clock span across all
   *  agents (max end − min start; parallel-aware, NOT a sum of per-agent durations). */
  totals: z.object({
    toolCount: z.number().int().nonnegative(),
    tokens: z.number().int().nonnegative(),
    durationMs: z.number().int().nonnegative().nullable(),
  }),
})
export type WorkflowTree = z.infer<typeof WorkflowTreeSchema>
