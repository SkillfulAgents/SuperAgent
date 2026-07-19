import * as path from 'path'
import { promises as fs } from 'fs'
import { isPathWithinDir } from '../utils/path-safety'
import { parseWorkflowScript } from './workflow-script-parser'
import {
  JournalLineSchema,
  WorkflowTreeSchema,
  displayAgentResult,
  type ParsedScript,
  type WorkflowAgentNode,
  type WorkflowTree,
} from './workflow-schemas'

// The join produces the structural fields; per-agent transcript stats (prompt,
// toolCount, tokens, durationMs) are layered on afterwards from readAgentStats.
type JoinedAgent = Omit<WorkflowAgentNode, 'prompt' | 'toolCount' | 'tokens' | 'durationMs'>

/**
 * Reconstruct a workflow's per-agent tree from its on-disk artifacts and join each
 * agent back to its script call site to recover the (label, phase) the wire never
 * carries.
 *
 * Sources (under the agent workspace, host-readable):
 *   <sessionsDir>/<sessionId>/subagents/workflows/<runId>/journal.jsonl   (status + result, ordered)
 *   <sessionsDir>/<sessionId>/subagents/workflows/<runId>/agent-<id>.jsonl (first user msg = the join key)
 *   <sessionsDir>/<sessionId>/workflows/scripts/<name>-<runId>.js          (phases + per-call label/phase)
 *   — plus the Workflow invocation mined from <sessionsDir>/<sessionId>.jsonl:
 *     the executed script's path for `scriptPath` runs (no session-dir copy
 *     exists) and the `args` input, which sizes `args.<key>` fan-outs.
 *
 * Returns null when the run dir / journal doesn't exist (→ the route 404s).
 */
export async function buildWorkflowTree(opts: {
  sessionsDir: string
  sessionId: string
  runId: string
}): Promise<WorkflowTree | null> {
  const { sessionsDir, sessionId, runId } = opts
  const runDir = path.join(sessionsDir, sessionId, 'subagents', 'workflows', runId)
  const journalPath = path.join(runDir, 'journal.jsonl')

  let journalRaw: string
  try {
    journalRaw = await fs.readFile(journalPath, 'utf8')
  } catch {
    return null
  }

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

  const invocation = await findWorkflowInvocation(sessionsDir, sessionId, runId)
  const script = await loadScript(sessionsDir, sessionId, runId, invocation.scriptHostPath)
  const stats = new Map<string, AgentStats>()
  await Promise.all(
    startedOrder.map(async (agentId) => {
      stats.set(agentId, await readAgentStats(path.join(runDir, `agent-${agentId}.jsonl`)))
    })
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
    const i = call.holeExprs.indexOf(expr.trim())
    if (i >= 0 && i < captures.length) return captures[i]
    unresolved = true
    return ''
  })
  return unresolved ? fallback : label
}

async function loadScript(
  sessionsDir: string,
  sessionId: string,
  runId: string,
  invocationScriptPath: string | null
): Promise<ParsedScript> {
  const empty: ParsedScript = { name: null, description: null, phases: [], agentCalls: [] }
  // Canonical location: inline-`script` invocations get a copy persisted here.
  const scriptsDir = path.join(sessionsDir, sessionId, 'workflows', 'scripts')
  try {
    const entries = await fs.readdir(scriptsDir)
    const file = entries.find((f) => f.endsWith(`${runId}.js`))
    if (file) return parseWorkflowScript(await fs.readFile(path.join(scriptsDir, file), 'utf8'))
  } catch {
    // fall through to the invocation-referenced path
  }
  // `scriptPath` invocations run a caller-owned file (e.g. a skill's script) and
  // persist nothing under the session dir — read the file the invocation named.
  if (invocationScriptPath) {
    try {
      return parseWorkflowScript(await fs.readFile(invocationScriptPath, 'utf8'))
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
  /** Host path of the executed script, contained within the agent workspace; null if unknown. */
  scriptHostPath: string | null
  /** The invocation's `args` input, verbatim; undefined if unknown. */
  args: unknown
}

/**
 * Mine the run's Workflow invocation out of the parent session transcript: the
 * tool_result names the executed script (`Script file: <container path>`) and its
 * paired tool_use input carries `args` (sizes fan-outs) and, for `scriptPath`
 * invocations, the caller-owned script location. Container paths (`/workspace/...`)
 * are mapped onto the host workspace dir; anything escaping it is ignored.
 */
async function findWorkflowInvocation(
  sessionsDir: string,
  sessionId: string,
  runId: string
): Promise<WorkflowInvocation> {
  const none: WorkflowInvocation = { scriptHostPath: null, args: undefined }
  let raw: string
  try {
    raw = await fs.readFile(path.join(sessionsDir, `${sessionId}.jsonl`), 'utf8')
  } catch {
    return none
  }
  // sessionsDir = <workspace>/.claude/projects/-workspace
  const workspaceDir = path.resolve(sessionsDir, '..', '..', '..')

  const inputsByToolUseId = new Map<string, Record<string, unknown>>()
  let resultText: string | null = null
  let resultToolUseId: string | null = null
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let entry: { message?: { content?: unknown } }
    try {
      entry = JSON.parse(trimmed)
    } catch {
      continue
    }
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
  if (resultText === null) return none

  const input = resultToolUseId !== null ? inputsByToolUseId.get(resultToolUseId) : undefined
  // Prefer the result's `Script file:` line (present for inline-`script` runs too,
  // pointing at the persisted copy); fall back to the tool_use's own scriptPath.
  const containerPath =
    /Script file: (\/workspace\/\S+)/.exec(resultText)?.[1] ??
    (typeof input?.scriptPath === 'string' ? input.scriptPath : null)
  let scriptHostPath: string | null = null
  if (containerPath?.startsWith('/workspace/')) {
    const host = path.join(workspaceDir, containerPath.slice('/workspace/'.length))
    if (isPathWithinDir(workspaceDir, host)) scriptHostPath = host
  }
  return { scriptHostPath, args: input?.args }
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
async function readAgentStats(filePath: string): Promise<AgentStats> {
  const empty: AgentStats = {
    firstPrompt: '',
    toolCount: 0,
    tokens: 0,
    firstTs: null,
    lastTs: null,
    trailingError: null,
  }
  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf8')
  } catch {
    return empty
  }
  let firstPrompt = ''
  let toolCount = 0
  let tokens = 0
  let firstTs: number | null = null
  let lastTs: number | null = null
  let trailingError: string | null = null
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let entry: {
      type?: string
      timestamp?: string
      error?: unknown
      errorDetails?: unknown
      message?: { content?: unknown; usage?: { output_tokens?: number } }
    }
    try {
      entry = JSON.parse(trimmed)
    } catch {
      continue
    }
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
    }
  }
  return { firstPrompt, toolCount, tokens, firstTs, lastTs, trailingError }
}
