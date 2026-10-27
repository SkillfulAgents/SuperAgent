/**
 * The subagents a session's turn launched (Task / Agent tool calls), as the
 * activity tray and the transcript's subagent cards show them: what each one
 * is streaming right now, its progress, and whether it is still running.
 *
 * Entries are keyed by the launching tool call. A subagent's own frames
 * (sidechain frames, `parent_tool_use_id` set) stream into its entry; its
 * lifecycle arrives on the main stream (`task_started`, `task_progress`, the
 * terminal task frames) and through the launching call's tool result.
 */
import { redactStreamedToolInput } from './redaction'
import type { SessionEvent } from './session-channel'

export interface SubagentEntry {
  agentId: string | null
  currentText: string
  currentToolUse: { id: string; name: string } | null
  currentToolInput: string
  /** Streamed launch hint, confirmed by an async launch acknowledgement. */
  isBackground: boolean
  /** A SendMessage-resumed run: an authoritative task_started or result says so. */
  isResumed: boolean
  subagentType?: string
  description?: string
  progressSummary?: string
  usage?: { total_tokens: number; tool_uses: number; duration_ms: number }
  lastToolName?: string
  completed?: boolean
}

/** A subagent as clients see it, in the `connected` snapshot. */
export interface ActiveSubagentSnapshot {
  parentToolId: string
  agentId: string | null
  streamingMessage: string | null
  streamingToolUse: { id: string; name: string; partialInput: string } | null
  progressSummary: string | null
  subagentType: string | null
  description: string | null
  usage: { total_tokens: number; tool_uses: number; duration_ms: number } | null
  lastToolName: string | null
  status: 'running' | 'completed'
}

/** A tool call a subagent finished making: the session decides what it triggers. */
export interface SubagentToolUse {
  id: string
  name: string
  /** The input as JSON text. */
  input: string
}

export interface SubagentSink {
  emit(event: SessionEvent): void
  /** A subagent runs as a background task (an async launch, a resumed run): track it like one. */
  registerBackground(agentId: string, toolUseId: string): void
  /** Whether the background tasks list this agent as a subagent task. */
  isBackgroundSubagent(agentId: string): boolean
  /** A subagent ended: anything it left parked can never be answered now. */
  ended(parentToolId: string): void
}

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'killed', 'stopped'])

function newEntry(fields: Partial<SubagentEntry> = {}): SubagentEntry {
  return { agentId: null, currentText: '', currentToolUse: null, currentToolInput: '', isBackground: false, isResumed: false, ...fields }
}

/** The text of a tool result block: a string, or its text parts joined. */
function resultTextOf(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  return content
    .filter((part: { type?: string }) => part?.type === 'text')
    .map((part: { text?: string }) => part.text || '')
    .join('')
}

export class Subagents {
  private readonly entries = new Map<string, SubagentEntry>()
  /** Agents that finished in this attachment: a new task_started for one is a resumed run. */
  private readonly completedAgentIds = new Set<string>()

  constructor(private readonly sink: SubagentSink) {}

  get size(): number {
    return this.entries.size
  }

  /** The subagents launched in the current turn, running or done, for the `connected` snapshot. */
  snapshot(): ActiveSubagentSnapshot[] {
    return [...this.entries]
      .filter(([, sub]) => !!sub.agentId || !!sub.subagentType)
      .map(([parentToolId, sub]) => ({
        parentToolId,
        agentId: sub.agentId,
        streamingMessage: sub.currentText || null,
        streamingToolUse: sub.currentToolUse
          ? { ...sub.currentToolUse, partialInput: redactStreamedToolInput(sub.currentToolUse.name, sub.currentToolInput) }
          : null,
        progressSummary: sub.progressSummary ?? null,
        subagentType: sub.subagentType ?? null,
        description: sub.description ?? null,
        usage: sub.usage ?? null,
        lastToolName: sub.lastToolName ?? null,
        status: sub.completed ? 'completed' : 'running',
      }))
  }

  /** A new turn: its subagents are new. (Completed agent ids stay: a later run of one is a resume.) */
  clear(): void {
    this.entries.clear()
  }

  /**
   * The turn was stopped but its process kept: foreground subagents died
   * with the turn; background and resumed ones are tasks of their own and
   * settle through their terminal task frames.
   */
  dropForeground(): void {
    for (const [parentToolId, sub] of [...this.entries]) {
      if (!sub.isBackground && !sub.isResumed) this.entries.delete(parentToolId)
    }
  }

  /**
   * A frame from a subagent that survived a soft interrupt. Foreground
   * subagents leave the map when the turn is stopped and a restart clears it,
   * so a frame that still resolves to an entry belongs to work that is running.
   */
  isSparedFrame(parentToolUseId: unknown): boolean {
    if (typeof parentToolUseId !== 'string') return false
    const sub = this.entries.get(parentToolUseId)
    return !!sub && (sub.isBackground || sub.isResumed)
  }

  /** The agent finished a Task/Agent call: an entry for it, background when its input asked for that. */
  trackLaunch(toolUseId: string, input: unknown): void {
    let isBackground = false
    try {
      const parsed = typeof input === 'string' ? JSON.parse(input) : input
      // A fork (CLI 2.1.302+) always runs in the background and takes no
      // run_in_background.
      isBackground = !!(
        parsed &&
        typeof parsed === 'object' &&
        (('run_in_background' in parsed && parsed.run_in_background) ||
          ('subagent_type' in parsed && parsed.subagent_type === 'fork'))
      )
    } catch {
      // Partial or invalid JSON: a foreground launch.
    }
    const existing = this.entries.get(toolUseId)
    if (existing) {
      if (isBackground) existing.isBackground = true
      return
    }
    this.entries.set(toolUseId, newEntry({ isBackground }))
  }

  /**
   * `task_started`. task_id is the subagent's agent id (SDK 0.3.142+: also its
   * session id and transcript name), so this sets the id deterministically.
   */
  taskStarted(content: {
    tool_use_id?: unknown
    task_id?: unknown
    task_type?: unknown
    is_backgrounded?: unknown
    subagent_type?: unknown
    description?: unknown
  }): void {
    const toolUseId = typeof content.tool_use_id === 'string' ? content.tool_use_id : undefined
    const agentId = typeof content.task_id === 'string' ? content.task_id : undefined
    const isResumed = content.task_type === 'local_agent' && !!agentId && this.completedAgentIds.has(agentId)
    // A cold or reattached host may have seen neither the launch ack nor the
    // previous run; the runtime identifies background work without them,
    // including an automatic rerun under the same call.
    const isBackground = content.task_type === 'local_agent' && (
      content.is_backgrounded === true || (!!agentId && this.sink.isBackgroundSubagent(agentId))
    )
    // A subagent's own inner Bash can surface on the parent stream as an
    // unparented local_bash task_started: it is not a subagent, and an entry
    // for it would render a phantom card for the whole background wait.
    if (!toolUseId || content.task_type === 'local_bash') return

    const existing = this.entries.get(toolUseId)
    if (existing) {
      if (agentId) existing.agentId = agentId
      if (isBackground) existing.isBackground = true
      if (isResumed) existing.isResumed = true
      // A new run under the SAME launching call (CLI 2.1.296+: a subagent whose
      // own background Bash finishes after its turn is re-run to receive that
      // result). The entry still carries the first run's completion; without
      // reopening it, this run would never report subagent_completed.
      if (isResumed && existing.completed) existing.completed = false
    } else {
      this.entries.set(toolUseId, newEntry({ agentId: agentId ?? null, isBackground, isResumed }))
    }
    const tracked = this.entries.get(toolUseId)!
    if (typeof content.subagent_type === 'string') tracked.subagentType = content.subagent_type
    if (typeof content.description === 'string') tracked.description = content.description
    if ((isBackground || isResumed) && agentId) this.sink.registerBackground(agentId, toolUseId)
    this.sink.emit({
      type: 'subagent_started',
      parentToolId: toolUseId,
      taskId: agentId,
      agentId,
      subagentType: content.subagent_type,
      description: content.description,
    })
  }

  /**
   * `task_progress`: usage and the latest summary. The description is left
   * alone: the header keeps the task's original one, while a progress frame's
   * describes the current action.
   */
  taskProgress(content: {
    tool_use_id?: unknown
    task_id?: unknown
    summary?: unknown
    subagent_type?: unknown
    usage?: SubagentEntry['usage']
    last_tool_name?: unknown
  }): void {
    const sub = typeof content.tool_use_id === 'string' ? this.entries.get(content.tool_use_id) : undefined
    if (sub) {
      if (typeof content.summary === 'string') sub.progressSummary = content.summary
      if (typeof content.subagent_type === 'string') sub.subagentType = content.subagent_type
      if (content.usage) sub.usage = content.usage
      if (typeof content.last_tool_name === 'string') sub.lastToolName = content.last_tool_name
    }
    this.sink.emit({
      type: 'subagent_progress',
      parentToolId: content.tool_use_id,
      // task_id is the subagent's agent id, so every subagent event names its agent.
      agentId: typeof content.task_id === 'string' ? content.task_id : undefined,
      summary: content.summary,
      subagentType: content.subagent_type,
      usage: content.usage,
      lastToolName: content.last_tool_name,
    })
  }

  /**
   * A terminal `task_updated` for this task id. A background subagent can
   * settle this way without a task_notification. Only background and resumed
   * runs: foreground subagents complete through their tool result, and acting
   * here would complete them early, before their agent id is known.
   */
  taskEnded(taskId: string): void {
    for (const [parentToolId, sub] of this.entries) {
      if (!sub.completed && (sub.isBackground || sub.isResumed) && sub.agentId === taskId) {
        this.complete(parentToolId)
        return
      }
    }
  }

  /**
   * A terminal `task_notification` for the launching call: how a background
   * subagent reports completion (its tool result stays the async-launch ack,
   * and no sidechain result arrives). Background and resumed runs only, as above.
   */
  taskNotification(toolUseId: unknown, status: unknown, summary: unknown): void {
    if (typeof toolUseId !== 'string' || typeof status !== 'string' || !TERMINAL_STATUSES.has(status)) return
    const sub = this.entries.get(toolUseId)
    if (sub?.isBackground || sub?.isResumed) {
      this.complete(toolUseId, typeof summary === 'string' ? summary : undefined)
    }
  }

  /** The level set lists these agents as background subagent tasks. */
  markBackground(agentIds: Iterable<string>): void {
    const ids = new Set(agentIds)
    for (const sub of this.entries.values()) {
      if (sub.agentId && ids.has(sub.agentId)) sub.isBackground = true
    }
  }

  /**
   * Tool results on the main stream for tracked launches: the result names
   * the agent, says whether it was launched (or resumed) in the background,
   * and otherwise ends a foreground run.
   */
  toolResults(content: { message?: { content?: unknown }; tool_use_result?: unknown }): void {
    if (this.entries.size === 0) return
    const blocks = content.message?.content
    if (!Array.isArray(blocks)) return
    for (const block of blocks) {
      if (block?.type !== 'tool_result' || !this.entries.has(block.tool_use_id)) continue
      const sub = this.entries.get(block.tool_use_id)!
      const result = content.tool_use_result as
        | { status?: string; isAsync?: boolean; agentId?: string; resumedAgentId?: string }
        | undefined

      if (!sub.agentId) {
        if (typeof result?.agentId === 'string') {
          sub.agentId = result.agentId
        } else if (typeof result?.resumedAgentId === 'string') {
          sub.agentId = result.resumedAgentId
        } else {
          const parts = Array.isArray(block.content) ? block.content : []
          for (const part of parts) {
            if (part?.type !== 'text' || typeof part.text !== 'string') continue
            const match = part.text.match(/\bagentId:\s*([a-f0-9]+)\b/)
            if (match) {
              sub.agentId = match[1]
              break
            }
          }
        }
      }

      const isAsyncLaunchAck = result?.status === 'async_launched' || result?.isAsync === true
      const isResumeAck = typeof result?.resumedAgentId === 'string'
      if (block.is_error !== true && (isAsyncLaunchAck || isResumeAck || sub.isResumed)) {
        if (isAsyncLaunchAck) sub.isBackground = true
        if (isResumeAck) sub.isResumed = true
        const backgroundAgentId = result?.resumedAgentId ?? result?.agentId ?? sub.agentId
        if (backgroundAgentId) this.sink.registerBackground(backgroundAgentId, block.tool_use_id)
        continue
      }
      this.complete(block.tool_use_id, resultTextOf(block.content))
    }
  }

  /**
   * The entry a sidechain frame streams into, created if the frame beat its
   * launch. A frame names the call that FIRST launched its agent
   * (parent_tool_use_id), even during a later run started by SendMessage,
   * whose task_started registered that run under the SendMessage call; the
   * frame's agent id says which run is live, and the live run wins.
   */
  routeFrame(content: { parent_tool_use_id?: unknown; agent_id?: unknown; agentId?: unknown }): string {
    // SDK 0.3.292+ stamps `agent_id` on a subagent's frames; `agentId` is the
    // transcript's spelling, which the live stream never carried.
    const agentId = (content.agent_id ?? content.agentId) as string | undefined
    const parentToolId = this.liveRunFor(content.parent_tool_use_id as string, agentId)
    let sub = this.entries.get(parentToolId)
    if (!sub) {
      sub = newEntry()
      this.entries.set(parentToolId, sub)
    }
    // Learn the agent id from the frame (belt and braces with task_started).
    if (agentId && !sub.agentId) {
      sub.agentId = agentId
      this.sink.emit({ type: 'subagent_updated', parentToolId, agentId })
    }
    // A reattach mid-run replays the level set, not task_started or the async
    // launch ack: recover the flag when a frame identifies a running agent.
    if (sub.agentId && this.sink.isBackgroundSubagent(sub.agentId)) sub.isBackground = true
    return parentToolId
  }

  /** One of a subagent's stream events. Returns the tool call it finished, if any. */
  streamEvent(
    parentToolId: string,
    event: { type: string; content_block?: { type: string; id?: string; name?: string }; delta?: { type: string; text?: string; partial_json?: string } },
  ): SubagentToolUse | null {
    const sub = this.entries.get(parentToolId)
    if (!sub) return null
    const agentId = sub.agentId
    switch (event.type) {
      case 'message_start':
        sub.currentText = ''
        sub.currentToolUse = null
        sub.currentToolInput = ''
        this.sink.emit({ type: 'subagent_stream_start', parentToolId, agentId })
        return null
      case 'content_block_start':
        if (event.content_block?.type === 'tool_use') {
          sub.currentToolUse = { id: event.content_block.id!, name: event.content_block.name! }
          sub.currentToolInput = ''
          this.sink.emit({
            type: 'subagent_tool_use_start',
            parentToolId,
            agentId,
            toolId: event.content_block.id,
            toolName: event.content_block.name,
            partialInput: '',
          })
        }
        return null
      case 'content_block_delta':
        if (event.delta?.type === 'text_delta' && event.delta.text) {
          sub.currentText += event.delta.text
          this.sink.emit({ type: 'subagent_stream_delta', parentToolId, agentId, text: event.delta.text })
        } else if (event.delta?.type === 'input_json_delta') {
          sub.currentToolInput += event.delta.partial_json || ''
          this.sink.emit({
            type: 'subagent_tool_use_streaming',
            parentToolId,
            agentId,
            toolId: sub.currentToolUse?.id,
            toolName: sub.currentToolUse?.name,
            partialInput: redactStreamedToolInput(sub.currentToolUse?.name, sub.currentToolInput),
          })
        }
        return null
      case 'content_block_stop':
        return sub.currentToolUse
          ? { id: sub.currentToolUse.id, name: sub.currentToolUse.name, input: sub.currentToolInput }
          : null
      case 'message_stop':
        sub.currentToolUse = null
        sub.currentToolInput = ''
        return null
      default:
        return null
    }
  }

  /** The subagent's finished tool call has been acted on: its card stops streaming. */
  toolUseReady(parentToolId: string): void {
    const sub = this.entries.get(parentToolId)
    if (!sub?.currentToolUse) return
    this.sink.emit({
      type: 'subagent_tool_use_ready',
      parentToolId,
      agentId: sub.agentId,
      toolId: sub.currentToolUse.id,
      toolName: sub.currentToolUse.name,
    })
    sub.currentToolUse = null
    sub.currentToolInput = ''
  }

  /**
   * A subagent's complete assistant message. Its text goes out as a delta
   * (subagent messages often arrive whole, with no stream events before
   * them). Returns the tool calls it made.
   */
  assistantMessage(parentToolId: string, content: { message?: { content?: unknown } }): SubagentToolUse[] {
    const sub = this.entries.get(parentToolId)
    const blocks = content.message?.content
    if (!sub || !Array.isArray(blocks)) return []
    const text = blocks
      .filter((b: { type: string }) => b.type === 'text')
      .map((b: { text?: string }) => b.text || '')
      .join('')
    if (text && text !== sub.currentText) {
      const continues = text.startsWith(sub.currentText)
      const delta = continues ? text.slice(sub.currentText.length) : text
      if (delta) {
        if (!continues) this.sink.emit({ type: 'subagent_stream_start', parentToolId, agentId: sub.agentId })
        this.sink.emit({ type: 'subagent_stream_delta', parentToolId, agentId: sub.agentId, text: delta })
      }
    }
    sub.currentText = text
    return blocks
      .filter((b: { type: string }) => b.type === 'tool_use')
      .map((b: { id: string; name: string; input?: unknown }) => ({ id: b.id, name: b.name, input: JSON.stringify(b.input || {}) }))
  }

  /** A complete subagent message was persisted: the client refetches it. */
  messageUpdated(parentToolId: string): void {
    this.sink.emit({ type: 'subagent_updated', parentToolId, agentId: this.entries.get(parentToolId)?.agentId ?? null })
  }

  /**
   * The subagent finished (or its run did). Clients refetch its transcript
   * and close the card; once only per run.
   */
  complete(parentToolId: string, resultText?: string): void {
    const sub = this.entries.get(parentToolId)
    if (sub?.completed) return
    const agentId = sub?.agentId ?? null
    this.sink.emit({ type: 'subagent_updated', parentToolId, agentId })
    this.sink.emit({ type: 'subagent_completed', parentToolId, agentId, ...(resultText && { resultText }) })
    if (sub?.agentId) this.completedAgentIds.add(sub.agentId)
    if (sub) sub.completed = true
    this.sink.ended(parentToolId)
  }

  private liveRunFor(parentToolId: string, agentId: string | undefined): string {
    if (!agentId) return parentToolId
    const named = this.entries.get(parentToolId)
    if (named && !named.completed && (named.agentId === agentId || named.agentId === null)) return parentToolId
    let live: string | null = null
    for (const [toolId, sub] of this.entries) {
      if (sub.agentId === agentId && !sub.completed) live = toolId
    }
    return live ?? parentToolId
  }
}
