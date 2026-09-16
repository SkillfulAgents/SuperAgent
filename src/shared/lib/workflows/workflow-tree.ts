import pLimit from 'p-limit'
import { streamJsonl } from '@shared/lib/agent-actor/jsonl-files'
import type { FileOps } from '@shared/lib/agent-actor/types'
import { WorkspaceFileError, joinWorkspacePath, normalizeWorkspacePath } from '@shared/lib/agent-actor/workspace-path'
import { parseWorkflowScript } from './workflow-script-parser'
import {
  AgentMetaSchema,
  JournalLineSchema,
  WorkflowTreeSchema,
  displayAgentResult,
  modelSlugFromAgentType,
  type ParsedScript,
  type WorkflowAgentNode,
  type WorkflowTree,
} from './workflow-schemas'

// The join produces the structural fields; per-agent transcript stats (prompt,
// toolCount, tokens, durationMs, model) are layered on afterwards from readAgentStats.
type JoinedAgent = Omit<WorkflowAgentNode, 'prompt' | 'toolCount' | 'tokens' | 'durationMs' | 'model'>

/**
 * How many agent transcripts readAgentStats has open concurrently. Peak memory
 * is roughly this times the largest transcript, so it bounds the drawer's cost
 * on a run with hundreds of agents instead of scaling with the run.
 */
const AGENT_STATS_CONCURRENCY = 10

/** The agent's workspace and the directory its transcripts are in, as workspace paths. */
export interface WorkflowTreeSource {
  files: FileOps
  transcriptsDir: string
  sessionId: string
  runId: string
}

/** A workspace text file, or null when it is absent or not a file. */
async function readText(files: FileOps, path: string): Promise<string | null> {
  try {
    const bytes = await files.getDoc(path)
    return bytes === null ? null : Buffer.from(bytes).toString('utf8')
  } catch (error) {
    if (error instanceof WorkspaceFileError) return null
    throw error
  }
}

/**
 * Reconstruct a workflow's per-agent tree from its stored artifacts and join
 * each agent back to its script call site to recover the (label, phase) the
 * wire never carries.
 *
 * Sources (under the agent workspace, read through its file operations):
 *   <transcriptsDir>/<sessionId>/subagents/workflows/<runId>/journal.jsonl   (status + result, ordered)
 *   <transcriptsDir>/<sessionId>/subagents/workflows/<runId>/agent-<id>.jsonl (first user msg = the join key)
 *   <transcriptsDir>/<sessionId>/workflows/scripts/<name>-<runId>.js          (phases + per-call label/phase)
 *   — plus the Workflow invocation mined from <transcriptsDir>/<sessionId>.jsonl:
 *     the executed script's path for `scriptPath` runs (no session-dir copy
 *     exists) and the `args` input, which sizes `args.<key>` fan-outs.
 *
 * Returns null when the run dir / journal doesn't exist (→ the route 404s).
 */
export async function buildWorkflowTree(opts: WorkflowTreeSource): Promise<WorkflowTree | null> {
  const { files, transcriptsDir, sessionId, runId } = opts
  const runDir = joinWorkspacePath(transcriptsDir, sessionId, 'subagents', 'workflows', runId)

  const journalRaw = await readText(files, joinWorkspacePath(runDir, 'journal.jsonl'))
  if (journalRaw === null) return null

  // Parse the journal in append order. A live-tailed journal can have a
  // half-written trailing line, so skip lines that don't validate rather than
  // failing the whole tree.
  const startedOrder: string[] = []
  const statusByAgent = new Map<string, { status: 'running' | 'done'; result?: unknown }>()
  for (const line of journalRaw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let json: unknown
    try {
      json = JSON.parse(trimmed)
    } catch {
      continue
    }
    const parsed = JournalLineSchema.safeParse(json)
    if (!parsed.success) continue
    const entry = parsed.data
    if (entry.type === 'started') {
      if (!statusByAgent.has(entry.agentId)) {
        startedOrder.push(entry.agentId)
        statusByAgent.set(entry.agentId, { status: 'running' })
      }
    } else {
      if (!statusByAgent.has(entry.agentId)) startedOrder.push(entry.agentId)
      statusByAgent.set(entry.agentId, { status: 'done', result: entry.result })
    }
  }

  const invocation = await findWorkflowInvocation(opts)
  const script = await loadScript(opts, invocation.scriptPath)
  const stats = new Map<string, AgentStats>()
  // A wide run has hundreds of agent transcripts and they are individually
  // large; reading them all at once puts the whole run dir in memory at peak.
  const statsLimit = pLimit(AGENT_STATS_CONCURRENCY)
  await Promise.all(
    startedOrder.map((agentId) =>
      statsLimit(async () => {
        const s = await readAgentStats(files, joinWorkspacePath(runDir, `agent-${agentId}.jsonl`))
        // The transcript names the model only once the first assistant turn lands;
        // the meta.json sidecar is written at spawn, so it fills the gap.
        if (s.model === null) {
          s.model = await readAgentMetaModel(files, joinWorkspacePath(runDir, `agent-${agentId}.meta.json`))
        }
        stats.set(agentId, s)
      })
    )
  )

  const firstPrompts = new Map([...stats].map(([id, s]) => [id, s.firstPrompt]))
  const agents = joinAgents({ startedOrder, statusByAgent, firstPrompts, script }).map((node) => {
    const s = stats.get(node.agentId)
    // The journal has no failure event — a dead agent is a `started` with no
    // `result`, forever. The durable marker is the transcript ending on a
    // synthetic error frame; self-correcting if the agent appends more entries.
    const failed = node.status === 'running' && s?.trailingError != null
    return {
      ...node,
      status: failed ? ('failed' as const) : node.status,
      result: node.result ?? (failed ? s.trailingError : null),
      prompt: s?.firstPrompt ?? '',
      toolCount: s?.toolCount ?? 0,
      tokens: s?.tokens ?? 0,
      durationMs: s && s.firstTs != null && s.lastTs != null ? Math.max(0, s.lastTs - s.firstTs) : null,
      model: s?.model ?? null,
    }
  })

  // Workflow span = latest end − earliest start across agents (parallel-aware).
  const firstTimes = [...stats.values()].map((s) => s.firstTs).filter((t): t is number => t != null)
  const lastTimes = [...stats.values()].map((s) => s.lastTs).filter((t): t is number => t != null)
  const totals = {
    toolCount: agents.reduce((n, a) => n + a.toolCount, 0),
    tokens: agents.reduce((n, a) => n + a.tokens, 0),
    durationMs:
      firstTimes.length && lastTimes.length ? Math.max(0, Math.max(...lastTimes) - Math.min(...firstTimes)) : null,
  }

  return WorkflowTreeSchema.parse({
    runId,
    name: script.name,
    description: script.description,
    phases: script.phases,
    agents,
    expectedAgents: expectedAgentCount(script, invocation.args),
    totals,
  })
}

function joinAgents(input: {
  startedOrder: string[]
  statusByAgent: Map<string, { status: 'running' | 'done'; result?: unknown }>
  firstPrompts: Map<string, string>
  script: ParsedScript
}): JoinedAgent[] {
  const { startedOrder, statusByAgent, firstPrompts, script } = input
  const usedCallIndices = new Set<number>()
  const nodes: JoinedAgent[] = []

  startedOrder.forEach((agentId, index) => {
    const firstPrompt = firstPrompts.get(agentId) ?? ''
    const st = statusByAgent.get(agentId) ?? { status: 'running' as const }

    // 1) prompt-regex match against every call site.
    const candidates = script.agentCalls
      .map((call) => {
        const m = new RegExp(call.promptRegexSource).exec(firstPrompt)
        return m ? { call, captures: m.slice(1) } : null
      })
      .filter((x): x is { call: ParsedScript['agentCalls'][number]; captures: string[] } => x !== null)

    let chosen: ParsedScript['agentCalls'][number] | null = null
    let captures: string[] = []
    let resolved: WorkflowAgentNode['resolved'] = 'prompt-regex'

    if (candidates.length === 1) {
      chosen = candidates[0].call
      captures = candidates[0].captures
    } else if (candidates.length > 1) {
      // Ambiguous: prefer a not-yet-used call site (disambiguates repeated prompts).
      const unused = candidates.find((c) => !usedCallIndices.has(c.call.sourceIndex))
      const pick = unused ?? candidates[0]
      chosen = pick.call
      captures = pick.captures
    } else {
      // 2) fallback: next unused call site in source order (keeps the script's phase).
      chosen = script.agentCalls.find((c) => !usedCallIndices.has(c.sourceIndex)) ?? null
      resolved = 'ordinal-fallback'
    }
    if (chosen) usedCallIndices.add(chosen.sourceIndex)

    nodes.push({
      agentId,
      label: resolveLabel(chosen, captures, index),
      phase: chosen ? chosen.phase ?? chosen.sourcePhase : null,
      status: st.status, // 'running' may be promoted to 'failed' once transcript stats are layered on
      result: displayAgentResult(st.result),
      resolved,
    })
  })

  return nodes
}

function resolveLabel(
  call: ParsedScript['agentCalls'][number] | null,
  captures: string[],
  index: number
): string {
  const fallback = `agent ${index + 1}`
  if (!call || call.labelTemplate === null) return fallback
  let label = call.labelTemplate
  if (!label.includes('${')) return label
  let unresolved = false
  label = label.replace(/\$\{([^}]*)\}/g, (_m, expr: string) => {
    const e = expr.trim()
    const i = call.holeExprs.indexOf(e)
    if (i >= 0 && i < captures.length) return captures[i]
    const viaJson = resolveFromJsonHole(e, call.holeExprs, captures)
    if (viaJson !== null) return viaJson
    unresolved = true
    return ''
  })
  return unresolved ? fallback : label
}

/**
 * A label hole like `${c.slug}` whose variable never appears bare in the prompt
 * but IS embedded whole as `${JSON.stringify(c, ...)}` (the common "here's the
 * record" fan-out shape): parse that capture and read the property path off it.
 * Returns null when the shape doesn't apply or the capture isn't valid JSON.
 */
function resolveFromJsonHole(labelExpr: string, holeExprs: string[], captures: string[]): string | null {
  const pathMatch = /^([A-Za-z_$][\w$]*)((?:\.[A-Za-z_$][\w$]*)+)$/.exec(labelExpr)
  if (!pathMatch) return null
  const root = pathMatch[1]
  const props = pathMatch[2].slice(1).split('.')
  const rootRe = new RegExp(`^JSON\\.stringify\\(\\s*${root.replace(/\$/g, '\\$')}\\s*[,)]`)
  const i = holeExprs.findIndex((h) => rootRe.test(h))
  if (i < 0 || i >= captures.length) return null
  let value: unknown
  try {
    value = JSON.parse(captures[i])
  } catch {
    return null
  }
  for (const p of props) {
    if (value === null || typeof value !== 'object') return null
    value = (value as Record<string, unknown>)[p]
  }
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : null
}

/** The model slug from an agent's spawn-time meta.json, or null if absent/unparsable. */
async function readAgentMetaModel(files: FileOps, metaPath: string): Promise<string | null> {
  try {
    const raw = await readText(files, metaPath)
    if (raw === null) return null
    const parsed = AgentMetaSchema.safeParse(JSON.parse(raw))
    return parsed.success ? modelSlugFromAgentType(parsed.data.agentType) : null
  } catch {
    return null
  }
}

async function loadScript(
  { files, transcriptsDir, sessionId, runId }: WorkflowTreeSource,
  invocationScriptPath: string | null
): Promise<ParsedScript> {
  const empty: ParsedScript = { name: null, description: null, phases: [], agentCalls: [] }
  // Canonical location: inline-`script` invocations get a copy persisted here.
  const scriptsDir = joinWorkspacePath(transcriptsDir, sessionId, 'workflows', 'scripts')
  try {
    const entries = await files.list(scriptsDir)
    const file = entries.find((entry) => entry.kind === 'file' && entry.name.endsWith(`${runId}.js`))
    if (file) {
      const source = await readText(files, file.path)
      if (source !== null) return parseWorkflowScript(source)
    }
  } catch {
    // fall through to the invocation-referenced path
  }
  // `scriptPath` invocations run a caller-owned file (e.g. a skill's script) and
  // persist nothing under the session dir — read the file the invocation named.
  if (invocationScriptPath) {
    try {
      const source = await readText(files, invocationScriptPath)
      if (source !== null) return parseWorkflowScript(source)
    } catch {
      // unreadable/unparsable script → same degraded tree as before
    }
  }
  return empty
}

/**
 * Estimated total agents for the run: a call site fanning out over a Workflow
 * `args` array counts as that array's actual length; every other call site counts
 * as 1. Still a lower bound — fan-outs over runtime-computed collections (an
 * earlier phase's output) can't be sized statically.
 */
function expectedAgentCount(script: ParsedScript, args: unknown): number {
  const argsObj =
    args !== null && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : null
  return script.agentCalls.reduce((n, call) => {
    if (call.fanOutArgsKey && argsObj) {
      const list = argsObj[call.fanOutArgsKey]
      if (Array.isArray(list)) return n + list.length
    }
    return n + 1
  }, 0)
}

interface WorkflowInvocation {
  /** Workspace path of the executed script, or null if unknown or outside the workspace. */
  scriptPath: string | null
  /** The invocation's `args` input, verbatim; undefined if unknown. */
  args: unknown
}

/**
 * Mine the run's Workflow invocation out of the parent session transcript: the
 * tool_result names the executed script (`Script file: <container path>`) and its
 * paired tool_use input carries `args` (sizes fan-outs) and, for `scriptPath`
 * invocations, the caller-owned script location. Container paths (`/workspace/...`)
 * are workspace paths; anything that is not one is ignored.
 */
async function findWorkflowInvocation({ files, transcriptsDir, sessionId, runId }: WorkflowTreeSource): Promise<WorkflowInvocation> {
  const none: WorkflowInvocation = { scriptPath: null, args: undefined }

  const inputsByToolUseId = new Map<string, Record<string, unknown>>()
  let resultText: string | null = null
  let resultToolUseId: string | null = null
  try {
    // The parent transcript is the largest file this module touches; stream it
    // rather than holding it whole to pull one tool_use/tool_result pair out.
    const lines = streamJsonl<{ message?: { content?: unknown } }>(
      files,
      joinWorkspacePath(transcriptsDir, `${sessionId}.jsonl`)
    )
    for await (const entry of lines) {
      const content = entry.message?.content
      if (!Array.isArray(content)) continue
      for (const block of content as Array<Record<string, unknown>>) {
        if (block?.type === 'tool_use' && block.name === 'Workflow' && typeof block.id === 'string') {
          const input = block.input
          inputsByToolUseId.set(block.id, input !== null && typeof input === 'object' ? (input as Record<string, unknown>) : {})
        }
        if (resultText === null && block?.type === 'tool_result') {
          const text = messageText(block.content)
          if (text.includes(runId)) {
            resultText = text
            resultToolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : null
          }
        }
      }
    }
  } catch {
    return none
  }
  if (resultText === null) return none

  const input = resultToolUseId !== null ? inputsByToolUseId.get(resultToolUseId) : undefined
  // Prefer the result's `Script file:` line (present for inline-`script` runs too,
  // pointing at the persisted copy); fall back to the tool_use's own scriptPath.
  const containerPath =
    /Script file: (\/workspace\/\S+)/.exec(resultText)?.[1] ??
    (typeof input?.scriptPath === 'string' ? input.scriptPath : null)
  let scriptPath: string | null = null
  if (containerPath?.startsWith('/workspace/')) {
    try {
      scriptPath = normalizeWorkspacePath(containerPath)
    } catch {
      // A path that climbs out of the workspace names nothing readable here.
    }
  }
  return { scriptPath, args: input?.args }
}

interface AgentStats {
  firstPrompt: string
  toolCount: number
  tokens: number
  firstTs: number | null
  lastTs: number | null
  /** Error text when the transcript's FINAL entry is a synthetic error frame
   *  (`error` + `errorDetails` fields) — the durable marker of a dead agent. */
  trailingError: string | null
  /** Model id from the first assistant turn (`message.model`), or null before one lands. */
  model: string | null
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: string; text: string } => b?.type === 'text' && typeof b?.text === 'string')
      .map((b) => b.text)
      .join('\n')
  }
  return ''
}

/**
 * Read an agent's transcript once and derive: its first user prompt (the join key +
 * the task it started with), tool-call count, generated (output) tokens, and the
 * first/last timestamps (for duration). Tolerant of a half-written trailing line.
 */
async function readAgentStats(files: FileOps, filePath: string): Promise<AgentStats> {
  const empty: AgentStats = {
    firstPrompt: '',
    toolCount: 0,
    tokens: 0,
    firstTs: null,
    lastTs: null,
    trailingError: null,
    model: null,
  }
  let firstPrompt = ''
  let toolCount = 0
  let tokens = 0
  let firstTs: number | null = null
  let lastTs: number | null = null
  let trailingError: string | null = null
  let model: string | null = null
  try {
    // Streamed, not read whole: a single agent transcript can be tens of MB and
    // a wide run holds AGENT_STATS_CONCURRENCY of them open at once.
    const lines = streamJsonl<{
      type?: string
      timestamp?: string
      error?: unknown
      errorDetails?: unknown
      message?: { content?: unknown; usage?: { output_tokens?: number }; model?: unknown }
    }>(files, filePath)
    for await (const entry of lines) {
      // Track the error marker of the LAST entry only: a mid-transcript error the
      // agent recovered from must not read as failure, so any later entry clears it.
      trailingError =
        typeof entry.error === 'string'
          ? typeof entry.errorDetails === 'string'
            ? entry.errorDetails
            : entry.error
          : null
      if (typeof entry.timestamp === 'string') {
        const t = Date.parse(entry.timestamp)
        if (!Number.isNaN(t)) {
          if (firstTs == null) firstTs = t
          lastTs = t
        }
      }
      if (entry.type === 'user' && !firstPrompt) {
        firstPrompt = messageText(entry.message?.content)
      }
      if (entry.type === 'assistant') {
        const content = entry.message?.content
        if (Array.isArray(content)) {
          toolCount += content.filter((b) => (b as { type?: string })?.type === 'tool_use').length
        }
        tokens += entry.message?.usage?.output_tokens ?? 0
        if (model === null && typeof entry.message?.model === 'string' && entry.message.model) {
          model = entry.message.model
        }
      }
    }
  } catch {
    return empty
  }
  return { firstPrompt, toolCount, tokens, firstTs, lastTs, trailingError, model }
}
