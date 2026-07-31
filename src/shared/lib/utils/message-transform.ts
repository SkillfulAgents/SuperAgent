/**
 * Message Transform Utilities
 *
 * Transforms JSONL message entries from Claude SDK format to API response format.
 * Handles merging of streaming message chunks and attaching tool results.
 */

import { ContentBlock, JsonlMessageEntry, JsonlSystemEntry } from '@shared/lib/types/agent'
import { autopilotReviewEntrySchema } from '@shared/lib/autopilot/autopilot-schema'

export interface TransformedMessage {
  id: string
  type: 'user' | 'assistant'
  content: { text: string }
  toolCalls: Array<{
    id: string
    name: string
    input: Record<string, unknown>
    result?: string
    isError?: boolean
    subagent?: {
      agentId: string
      status: string
      totalDurationMs?: number
      totalTokens?: number
      totalToolUseCount?: number
    }
  }>
  createdAt: Date
  sender?: {
    id: string
    name: string
    email: string
  }
  /** SDK error code when assistant message failed due to LLM provider error */
  apiError?: string
  /** User message delivered mid-turn (queued/steering input) — does not end the turn it appears in */
  queued?: boolean
  /**
   * Summarized extended-thinking blocks, in order. Only present when the
   * transcript carries non-empty text (CLI 2.1.181+ — older transcripts persist
   * the block with an empty string, which is skipped). `durationMs` is derived
   * from entry timestamps (see thinkingByEntry) and absent when underivable.
   */
  thinking?: Array<{ text: string; durationMs?: number }>
}

export interface TransformedCompactBoundary {
  id: string
  type: 'compact_boundary'
  summary: string
  trigger: string
  preTokens?: number
  createdAt: Date
}

export interface TransformedMemoryRecall {
  id: string
  type: 'memory_recall'
  memoryPaths: string[]
  createdAt: Date
}

/**
 * Host-persisted informational banner (e.g. "prompt blocked by hook"). The CLI
 * emits these on the live stream only; the host appends them to the transcript
 * so they survive reloads.
 */
export interface TransformedInformational {
  id: string
  type: 'informational'
  content: string
  level?: string
  createdAt: Date
}

/**
 * Host-persisted autopilot decision: a watchdog stop review (done/continue/
 * blocked/escalated) or an approval-reviewer request decision (approved/
 * denied, `action` names the judged call). The payload lives JSON-stringified
 * in the entry's `content` and is parsed (leniently — malformed entries are
 * dropped, not thrown) here.
 */
export interface TransformedAutopilotReview {
  id: string
  type: 'autopilot_review'
  verdict: 'done' | 'continue' | 'blocked' | 'escalated' | 'approved' | 'denied'
  reasoning: string
  nudge?: string
  action?: string
  iteration?: number
  maxIterations?: number
  createdAt: Date
}

export type TransformedItem = TransformedMessage | TransformedCompactBoundary | TransformedMemoryRecall | TransformedInformational | TransformedAutopilotReview

/**
 * Parse a user message that may contain SDK-injected slash command XML tags.
 *
 * Claude Code SDK injects slash commands as user messages with XML markup:
 * - Command invocation: `<command-name>X</command-name>` optionally with `<command-args>Y</command-args>`
 * - Command output: `<local-command-stdout>...</local-command-stdout>`
 */
type ParsedCommand =
  | { type: 'slash-command'; name: string; args?: string }
  | { type: 'command-output'; content: string }

export function parseCommandMessage(text: string): ParsedCommand | null {
  const trimmed = text.trim()

  // Match <local-command-stdout>...</local-command-stdout>
  const stdoutMatch = trimmed.match(/^<local-command-stdout>([\s\S]*)<\/local-command-stdout>$/)
  if (stdoutMatch) {
    return { type: 'command-output', content: stdoutMatch[1] }
  }

  // Match command invocations — tags can appear in any order:
  // <command-name>, <command-message>, <command-args>
  // Only <command-name> is required; the others are optional.
  const nameMatch = trimmed.match(/<command-name>\/?([^<]+)<\/command-name>/)
  if (!nameMatch) return null

  // Verify the entire text is only these XML tags (no other content)
  const stripped = trimmed
    .replace(/<command-name>[^<]*<\/command-name>/g, '')
    .replace(/<command-message>[^<]*<\/command-message>/g, '')
    .replace(/<command-args>[\s\S]*?<\/command-args>/g, '')
    .trim()
  if (stripped !== '') return null

  const argsMatch = trimmed.match(/<command-args>([\s\S]*?)<\/command-args>/)
  return {
    type: 'slash-command',
    name: nameMatch[1],
    args: argsMatch?.[1]?.trim() || undefined,
  }
}

/**
 * Remove harness-injected <system-reminder> segments from user-message text.
 * Queued mid-turn messages get flattened to a single string by the CLI's
 * queued_command recording, so the block-level skip in the transform loop
 * can't catch riders there — this regex pass can.
 */
function stripUserSystemReminders(text: string): string {
  if (!text.includes('<system-reminder>')) return text
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trimEnd()
}

/**
 * Check if a user message only contains tool results (not a real user message)
 * These are filtered out because tool results are attached to their corresponding tool calls
 */
export function isToolResultOnlyMessage(entry: JsonlMessageEntry): boolean {
  if (entry.type !== 'user') return false

  const content = entry.message.content
  if (!Array.isArray(content)) return false

  // Check if all blocks are tool_result type
  return content.every((block: ContentBlock) => block.type === 'tool_result')
}

/**
 * Check if a user message is an SDK-injected task notification (sub-agent result).
 * These are internal messages that deliver sub-agent results back to the main agent
 * and should not be displayed as user messages.
 */
export function isTaskNotificationMessage(entry: JsonlMessageEntry): boolean {
  if (entry.type !== 'user') return false

  if (entry.origin?.kind === 'task-notification') return true

  // TODO deprecate 2026-08-01: XML fallback for JSONL files written before SDK 0.3.144 added the origin field
  const content = entry.message.content
  if (typeof content !== 'string') return false
  // Match both the bare `<task-notification>` form and attributed variants
  // (`<task-notification id="..." type="workflow-complete" ...>`).
  return /^<task-notification[\s>]/.test(content.trimStart())
}

/**
 * Transform JSONL messages to API response format
 *
 * This handles several complexities of the Claude SDK JSONL format:
 * 1. Assistant messages are streamed as separate entries with the same message.id
 *    - First entry might have just text, second entry has tool_use, etc.
 *    - We merge these into a single message
 * 2. Tool results come as separate user messages with tool_result content
 *    - We attach these results to the corresponding tool_use in the assistant message
 * 3. Empty string results (e.g., mkdir with no output) should be preserved as valid results
 * 4. Compact boundaries are paired with their following summary message
 */
export function transformMessages(entries: (JsonlMessageEntry | JsonlSystemEntry)[]): TransformedItem[] {
  // Pre-pass: identify compact boundaries, memory recalls, and pair them with their summary messages
  const compactBoundaries = new Map<number, { boundary: JsonlSystemEntry; summaryContent: string }>()
  const memoryRecalls = new Map<number, JsonlSystemEntry>()
  const informationals = new Map<number, JsonlSystemEntry>()
  const autopilotReviews = new Map<number, JsonlSystemEntry>()
  const skipIndices = new Set<number>()

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (entry.type === 'system' && (entry as JsonlSystemEntry).subtype === 'memory_recall') {
      const sysEntry = entry as JsonlSystemEntry
      skipIndices.add(i)
      // Dedupe by uuid: resume history replay re-appends system entries
      // verbatim too (see the message-entry dedup below)
      const isDuplicate = [...memoryRecalls.values()].some((e) => e.uuid === sysEntry.uuid)
      if (!isDuplicate) {
        memoryRecalls.set(i, sysEntry)
      }
    } else if (entry.type === 'system' && (entry as JsonlSystemEntry).subtype === 'informational') {
      const sysEntry = entry as JsonlSystemEntry
      skipIndices.add(i)
      // Dedupe by uuid: for some hook shapes (continue:false) the CLI persists
      // the banner itself with the SAME uuid it streamed, and the host appends
      // its own copy from the stream — keep whichever landed first.
      const isDuplicate = [...informationals.values()].some((e) => e.uuid === sysEntry.uuid)
      if (!isDuplicate) {
        informationals.set(i, sysEntry)
      }
      // The CLI also records a synthetic user entry carrying the same stop
      // text just before the banner ("Operation stopped by hook: ...") —
      // hide it; the banner is the user-facing surface. Checked for duplicate
      // copies too: when the host's appended banner lands before the CLI's,
      // the synthetic user entry precedes the CLI copy that dedupe drops.
      const prev = i > 0 ? entries[i - 1] : null
      if (
        prev &&
        prev.type === 'user' &&
        typeof (prev as JsonlMessageEntry).message.content === 'string' &&
        (prev as JsonlMessageEntry).message.content === sysEntry.content
      ) {
        skipIndices.add(i - 1)
      }
    } else if (entry.type === 'system' && (entry as JsonlSystemEntry).subtype === 'autopilot_review') {
      const sysEntry = entry as JsonlSystemEntry
      skipIndices.add(i)
      // Dedupe by uuid: resume history replay re-appends system entries verbatim
      const isDuplicate = [...autopilotReviews.values()].some((e) => e.uuid === sysEntry.uuid)
      if (!isDuplicate) {
        autopilotReviews.set(i, sysEntry)
      }
    } else if (entry.type === 'system' && (entry as JsonlSystemEntry).subtype === 'compact_boundary') {
      const sysEntry = entry as JsonlSystemEntry
      // Dedupe replayed copies (same uuid). Today a duplicate is also masked
      // by boundaryBeforeUuid keying on the NEXT message's uuid (the replayed
      // pair overwrites the original slot), but that only holds when the
      // following entry replays too — dedupe explicitly instead. The replayed
      // summary user message needs no pairing here: the standalone
      // isCompactSummary skip below hides it.
      const isDuplicate = [...compactBoundaries.values()].some((e) => e.boundary.uuid === sysEntry.uuid)
      if (isDuplicate) {
        skipIndices.add(i)
        continue
      }
      let summaryContent = ''

      // Look ahead for the next isCompactSummary user message (within a few entries)
      for (let j = i + 1; j < entries.length && j <= i + 3; j++) {
        const nextEntry = entries[j]
        if (nextEntry.type === 'user' && (nextEntry as JsonlMessageEntry).isCompactSummary) {
          const msgEntry = nextEntry as JsonlMessageEntry
          summaryContent = typeof msgEntry.message.content === 'string'
            ? msgEntry.message.content
            : ''
          skipIndices.add(j)
          break
        }
      }

      compactBoundaries.set(i, { boundary: sysEntry, summaryContent })
      skipIndices.add(i)
    }
    // Also skip any isCompactSummary messages that weren't paired
    if (entry.type === 'user' && (entry as JsonlMessageEntry).isCompactSummary) {
      skipIndices.add(i)
    }
  }

  // Filter to only message entries for the main transform pipeline.
  // Dedupe by uuid: when a session is resumed into a fresh CLI process, the
  // CLI can re-append the prior history to the transcript VERBATIM (same
  // uuids, same message.ids). Without this, the merge-by-message.id pass
  // below would stack the replayed content blocks onto the original
  // messages (tripled text, duplicated tool calls).
  const messageEntries: JsonlMessageEntry[] = []
  const seenUuids = new Set<string>()

  for (let i = 0; i < entries.length; i++) {
    if (skipIndices.has(i)) continue
    const entry = entries[i]
    if (entry.type === 'user' || entry.type === 'assistant') {
      const uuid = (entry as JsonlMessageEntry).uuid
      if (uuid) {
        if (seenUuids.has(uuid)) continue
        seenUuids.add(uuid)
      }
      messageEntries.push(entry as JsonlMessageEntry)
    }
  }

  // Merge assistant messages by message.id
  // Claude SDK writes separate entries for each content block (text, tool_use, etc.)
  // with the same message.id but different UUIDs. We need to merge them into one message.
  const mergedEntries: JsonlMessageEntry[] = []
  const assistantMessageIds = new Map<string, number>() // message.id -> index in mergedEntries

  // Extended-thinking blocks per merged entry. Extracted here — before the merge
  // collapses per-block entries — because the duration is derived from entry
  // timestamps: the CLI writes an assistant entry when its content block
  // completes, so (thinking entry ts − previous entry ts) ≈ how long the agent
  // thought. Old transcripts (pre CLI 2.1.181) persist the block with an empty
  // string (signature only) — those are skipped, they carry nothing to show.
  const thinkingByEntry = new Map<JsonlMessageEntry, Array<{ text: string; durationMs?: number }>>()
  let prevEntryTs: number | null = null
  // message.id of the entry prevEntryTs came from (null for user entries).
  // Some provider paths flush ALL of a message's block entries in one burst at
  // response completion, with thinking ordered after its sibling text block —
  // a gap measured against a sibling of the same message is milliseconds of
  // write jitter, not thinking time, and must not become a "Thought for 0s".
  let prevEntryMessageId: string | null = null

  for (const entry of messageEntries) {
    const messageId = entry.message.id
    let target = entry
    if (entry.type === 'assistant' && messageId) {
      const existingIndex = assistantMessageIds.get(messageId)
      if (existingIndex !== undefined) {
        // Merge content blocks into the existing entry
        const existing = mergedEntries[existingIndex]
        const existingContent = existing.message.content
        const newContent = entry.message.content

        if (Array.isArray(existingContent) && Array.isArray(newContent)) {
          // Append new content blocks to existing
          ;(existing.message.content as ContentBlock[]).push(...(newContent as ContentBlock[]))
        }
        // Keep the original entry's uuid and timestamp for correct ordering
        target = existing
      } else {
        // First time seeing this message.id - clone to avoid mutating original
        const clonedEntry = {
          ...entry,
          message: {
            ...entry.message,
            content: Array.isArray(entry.message.content)
              ? [...entry.message.content]
              : entry.message.content,
          },
        }
        assistantMessageIds.set(messageId, mergedEntries.length)
        mergedEntries.push(clonedEntry)
        target = clonedEntry
      }
    } else {
      // User messages or messages without id - keep as-is
      mergedEntries.push(entry)
    }

    const entryTs = new Date(entry.timestamp).getTime()
    if (entry.type === 'assistant' && Array.isArray(entry.message.content)) {
      const texts = (entry.message.content as ContentBlock[])
        // typeof guard: this runs server-side on raw JSONL — a malformed
        // non-string `thinking` must be skipped, not throw and 500 the route
        .filter((b) => b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim())
        .map((b) => (b as { thinking: string }).thinking)
      if (texts.length > 0) {
        // Only derivable when the previous entry is a different message (user
        // entry or another assistant response) — an intra-message gap is write
        // jitter. Underivable durations are omitted (header reads "Thought").
        const prevIsSameMessage = messageId !== undefined && prevEntryMessageId === messageId
        const durationMs =
          prevEntryTs !== null && !prevIsSameMessage && Number.isFinite(entryTs) && entryTs > prevEntryTs
            ? entryTs - prevEntryTs
            : undefined
        const list = thinkingByEntry.get(target) ?? []
        // The duration covers the whole entry — if one entry carries several
        // thinking blocks (rare), attach it to the first
        texts.forEach((text, i) => list.push(i === 0 && durationMs !== undefined ? { text, durationMs } : { text }))
        thinkingByEntry.set(target, list)
      }
    }
    if (Number.isFinite(entryTs)) {
      prevEntryTs = entryTs
      prevEntryMessageId = entry.type === 'assistant' ? (messageId ?? null) : null
    }
  }

  // First pass: build a map of tool_use_id -> result
  const toolResults = new Map<
    string,
    { content: string; isError: boolean; toolUseResult?: JsonlMessageEntry['toolUseResult'] }
  >()

  for (const entry of messageEntries) {
    if (entry.type !== 'user') continue

    const content = entry.message.content
    if (!Array.isArray(content)) continue

    for (const block of content as ContentBlock[]) {
      if (block.type === 'tool_result') {
        toolResults.set(block.tool_use_id, {
          content: block.content || '',
          isError: block.is_error || false,
          toolUseResult: entry.toolUseResult,
        })
      }
    }
  }

  // Build a map of message UUID -> system items that precede it
  // This allows us to insert boundaries/recalls at the correct position in the output
  const boundaryBeforeUuid = new Map<string, TransformedCompactBoundary>()
  const recallBeforeUuid = new Map<string, TransformedMemoryRecall[]>()
  const informationalBeforeUuid = new Map<string, TransformedInformational[]>()
  // Also track items that appear at the very end (no following message)
  const trailingBoundaries: TransformedCompactBoundary[] = []
  const trailingRecalls: TransformedMemoryRecall[] = []
  const trailingInformationals: TransformedInformational[] = []
  const autopilotReviewBeforeUuid = new Map<string, TransformedAutopilotReview[]>()
  const trailingAutopilotReviews: TransformedAutopilotReview[] = []

  for (const [idx, { boundary, summaryContent }] of compactBoundaries) {
    const item: TransformedCompactBoundary = {
      id: boundary.uuid,
      type: 'compact_boundary',
      summary: summaryContent,
      trigger: boundary.compactMetadata?.trigger || 'auto',
      preTokens: boundary.compactMetadata?.preTokens,
      createdAt: new Date(boundary.timestamp),
    }

    // Find the next non-skipped message entry after this boundary
    let nextUuid: string | null = null
    for (let j = idx + 1; j < entries.length; j++) {
      if (skipIndices.has(j)) continue
      const nextEntry = entries[j]
      if (nextEntry.type === 'user' || nextEntry.type === 'assistant') {
        nextUuid = (nextEntry as JsonlMessageEntry).uuid
        break
      }
    }

    if (nextUuid) {
      boundaryBeforeUuid.set(nextUuid, item)
    } else {
      trailingBoundaries.push(item)
    }
  }

  for (const [idx, sysEntry] of memoryRecalls) {
    const item: TransformedMemoryRecall = {
      id: sysEntry.uuid,
      type: 'memory_recall',
      memoryPaths: sysEntry.memory_paths || [],
      createdAt: new Date(sysEntry.timestamp),
    }

    let nextUuid: string | null = null
    for (let j = idx + 1; j < entries.length; j++) {
      if (skipIndices.has(j)) continue
      const nextEntry = entries[j]
      if (nextEntry.type === 'user' || nextEntry.type === 'assistant') {
        nextUuid = (nextEntry as JsonlMessageEntry).uuid
        break
      }
    }

    if (nextUuid) {
      const existing = recallBeforeUuid.get(nextUuid) || []
      existing.push(item)
      recallBeforeUuid.set(nextUuid, existing)
    } else {
      trailingRecalls.push(item)
    }
  }

  for (const [idx, sysEntry] of informationals) {
    const item: TransformedInformational = {
      id: sysEntry.uuid,
      type: 'informational',
      content: sysEntry.content || '',
      level: sysEntry.level,
      createdAt: new Date(sysEntry.timestamp),
    }

    let nextUuid: string | null = null
    for (let j = idx + 1; j < entries.length; j++) {
      if (skipIndices.has(j)) continue
      const nextEntry = entries[j]
      if (nextEntry.type === 'user' || nextEntry.type === 'assistant') {
        nextUuid = (nextEntry as JsonlMessageEntry).uuid
        break
      }
    }

    if (nextUuid) {
      const existing = informationalBeforeUuid.get(nextUuid) || []
      existing.push(item)
      informationalBeforeUuid.set(nextUuid, existing)
    } else {
      trailingInformationals.push(item)
    }
  }

  for (const [idx, sysEntry] of autopilotReviews) {
    // Content is a JSON payload written by the watchdog; a malformed entry is
    // dropped rather than 500-ing the messages route.
    let parsed: ReturnType<typeof autopilotReviewEntrySchema.safeParse>
    try {
      parsed = autopilotReviewEntrySchema.safeParse(JSON.parse(sysEntry.content || ''))
    } catch {
      continue
    }
    if (!parsed.success) continue

    const item: TransformedAutopilotReview = {
      id: sysEntry.uuid,
      type: 'autopilot_review',
      verdict: parsed.data.verdict,
      reasoning: parsed.data.reasoning,
      nudge: parsed.data.nudge,
      action: parsed.data.action,
      iteration: parsed.data.iteration,
      maxIterations: parsed.data.maxIterations,
      createdAt: new Date(sysEntry.timestamp),
    }

    let nextUuid: string | null = null
    for (let j = idx + 1; j < entries.length; j++) {
      if (skipIndices.has(j)) continue
      const nextEntry = entries[j]
      if (nextEntry.type === 'user' || nextEntry.type === 'assistant') {
        nextUuid = (nextEntry as JsonlMessageEntry).uuid
        break
      }
    }

    if (nextUuid) {
      const existing = autopilotReviewBeforeUuid.get(nextUuid) || []
      existing.push(item)
      autopilotReviewBeforeUuid.set(nextUuid, existing)
    } else {
      trailingAutopilotReviews.push(item)
    }
  }

  // Transform merged message entries, inserting boundaries at correct positions
  const result: TransformedItem[] = []

  for (const entry of mergedEntries) {
    // Insert any memory recalls that precede this message
    const recalls = recallBeforeUuid.get(entry.uuid)
    if (recalls) {
      result.push(...recalls)
    }

    // Insert any compact boundary that precedes this message
    const boundary = boundaryBeforeUuid.get(entry.uuid)
    if (boundary) {
      result.push(boundary)
    }

    // Insert any informational banners that precede this message
    const infos = informationalBeforeUuid.get(entry.uuid)
    if (infos) {
      result.push(...infos)
    }

    // Insert any autopilot watchdog decisions that precede this message
    const reviews = autopilotReviewBeforeUuid.get(entry.uuid)
    if (reviews) {
      result.push(...reviews)
    }

    // Skip user messages that only contain tool results
    if (isToolResultOnlyMessage(entry)) continue

    // Skip SDK-injected task notification messages (sub-agent results)
    if (isTaskNotificationMessage(entry)) continue

    const content = entry.message.content
    let text = ''
    let messageType: 'user' | 'assistant' = entry.type
    const toolCalls: TransformedMessage['toolCalls'] = []
    // Extracted during the merge pass (needs per-entry timestamps for durations)
    const thinking = thinkingByEntry.get(entry)

    if (typeof content === 'string') {
      text = entry.type === 'user' ? stripUserSystemReminders(content) : content
    } else if (Array.isArray(content)) {
      for (const block of content as ContentBlock[]) {
        if (block.type === 'text') {
          // Harness-injected riders on user messages (e.g. the autopilot
          // preflight reminder block) are model-facing only — the displayed
          // message must stay exactly what the user typed.
          if (entry.type === 'user' && block.text.trimStart().startsWith('<system-reminder>')) {
            continue
          }
          text += block.text
        } else if (block.type === 'tool_use') {
          const toolResult = toolResults.get(block.id)
          // Use toolUseResult.stdout if available, otherwise use content
          // Use ?? instead of || to preserve empty string as valid result (e.g., mkdir has no output)
          const resultContent =
            toolResult?.toolUseResult?.stdout ?? toolResult?.content ?? undefined

          const subagent = ((block.name === 'Task' || block.name === 'Agent') && toolResult?.toolUseResult?.agentId)
            ? {
                agentId: toolResult.toolUseResult.agentId!,
                status: toolResult.toolUseResult.status || 'completed',
                totalDurationMs: toolResult.toolUseResult.totalDurationMs,
                totalTokens: toolResult.toolUseResult.totalTokens,
                totalToolUseCount: toolResult.toolUseResult.totalToolUseCount,
              }
            : undefined

          toolCalls.push({
            id: block.id,
            name: block.name,
            input: block.input,
            result: resultContent,
            isError: toolResult?.isError,
            subagent,
          })
        }
      }
    }

    // Transform SDK-injected slash command messages
    if (entry.type === 'user' && text) {
      const parsed = parseCommandMessage(text)
      if (parsed) {
        if (parsed.type === 'slash-command') {
          text = parsed.args ? `/${parsed.name} ${parsed.args}` : `/${parsed.name}`
        } else if (parsed.type === 'command-output') {
          // Flip to assistant so output renders as an agent response
          messageType = 'assistant'
          text = parsed.content
        }
      }
    }

    result.push({
      id: entry.uuid,
      type: messageType,
      content: { text },
      toolCalls,
      createdAt: new Date(entry.timestamp),
      ...(entry.error && { apiError: entry.error }),
      ...(entry.isQueuedCommand && { queued: true }),
      ...(thinking && thinking.length > 0 && { thinking }),
    })
  }

  // Append any system items that appear after all messages
  result.push(...trailingRecalls)
  result.push(...trailingBoundaries)
  result.push(...trailingInformationals)
  result.push(...trailingAutopilotReviews)

  return result
}
