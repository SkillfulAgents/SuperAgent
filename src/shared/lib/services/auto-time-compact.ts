/**
 * Auto Time-Based Compact (V0: recency-only, no LLM)
 *
 * Appends a synthetic SDK-native `compact_boundary` plus a paired
 * `isCompactSummary` user message to the JSONL tail. The SDK's resume
 * reader (node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs, the
 * `hasPreservedSegment` branch) treats any compact_boundary without
 * `compactMetadata.preservedSegment` as a hard reset: every entry read
 * before the boundary is discarded, and the API request is built from
 * `[system_prompt, ...entries_after_boundary]` only. We only append
 * `[boundary, summary]` (no trailing entries), so the API context after
 * a compact becomes `[system_prompt, summary_as_user_message]`.
 *
 * Summary content reconstructs the conversation as a one-string transcript:
 *   - All human user-text turns are emitted with role tags.
 *   - The most recent `keepTurns` turns are kept verbatim (assistant text,
 *     tool_use, tool_result all inline).
 *   - Older turns keep their user/assistant text; any tool I/O is collapsed
 *     into a single `[...]` placeholder per contiguous run.
 *   - Per-tool-result text is truncated at TOOL_RESULT_MAX_CHARS to keep
 *     a single noisy snapshot from blowing up the summary.
 *
 * Cumulative: every tick re-parses the entire JSONL from scratch (skipping
 * our own boundaries / summary messages), so a fresh summary always
 * covers the full session.
 *
 * Triggered by auto-time-compact-coordinator. Off until the user enables
 * it via Settings > Runtime > Auto-Compact Idle Sessions.
 */

import * as fs from 'fs'
import { randomUUID } from 'crypto'
import { APP_VERSION } from '@shared/lib/config/version'
import { containerManager } from '@shared/lib/container/container-manager'
import { messagePersister } from '@shared/lib/container/message-persister'
import type {
  ContentBlock,
  JsonlEntry,
  JsonlMessageEntry,
  ToolResultBlock,
} from '@shared/lib/types/agent'
import {
  getSessionJsonlPath,
  readJsonlFile,
} from '@shared/lib/utils/file-storage'

const STRATEGY = 'time_recency'
const ENTRYPOINT_TAG = 'superagent-auto-time-compact'

// Trigger gate (hardcoded V0): we only burn a boundary when there's been
// real activity since the last one — at least one new human input *and*
// more than this many tool_use calls.
const MIN_NEW_USER_TEXT = 1
const MIN_NEW_TOOL_USES = 10

// Per-tool-result string cap — one giant snapshot output shouldn't be
// allowed to dominate the summary.
const TOOL_RESULT_MAX_CHARS = 8_000

// Single short placeholder for any contiguous run of dropped tool I/O
// in older turns. The marker is intentionally cheap (a few tokens).
const TOOL_PLACEHOLDER = '[...]'

function isCompactBoundaryEntry(entry: JsonlEntry | undefined): boolean {
  if (!entry) return false
  const e = entry as { type?: string; subtype?: string }
  return e.type === 'system' && e.subtype === 'compact_boundary'
}

/**
 * "Human user-text" = a message a real person typed. Excludes assistant
 * entries, tool_result user entries, and our own compact-summary entries.
 */
function isHumanUserText(entry: JsonlEntry | undefined): boolean {
  if (!entry) return false
  const e = entry as JsonlMessageEntry
  if (e.type !== 'user' || e.isCompactSummary) return false
  const content = e.message?.content
  if (typeof content === 'string') return true
  if (!Array.isArray(content)) return false
  return !content.some(
    (b) => (b as { type?: string }).type === 'tool_result'
  )
}

function findLatestBoundaryIndex(entries: JsonlEntry[]): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (isCompactBoundaryEntry(entries[i])) return i
  }
  return -1
}

function getBlocks(entry: JsonlMessageEntry): ContentBlock[] {
  const content = entry.message?.content
  if (typeof content === 'string') return [{ type: 'text', text: content } as ContentBlock]
  if (Array.isArray(content)) return content as ContentBlock[]
  return []
}

function extractUserTextString(entry: JsonlMessageEntry): string {
  const blocks = getBlocks(entry)
  const parts: string[] = []
  for (const block of blocks) {
    const b = block as { type?: string; text?: string }
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
  }
  return parts.join('\n').trim()
}

function extractAssistantTextString(entry: JsonlMessageEntry): string {
  return extractUserTextString(entry)
}

function stringifyToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) {
    try { return JSON.stringify(content) } catch { return String(content) }
  }
  const parts: string[] = []
  for (const block of content) {
    const b = block as { type?: string; text?: string }
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
    else if (b.type === 'image') parts.push('[image]')
    else {
      try { parts.push(JSON.stringify(block)) } catch { parts.push(String(block)) }
    }
  }
  return parts.join('\n')
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text
  return text.slice(0, limit) + `… [truncated ${text.length - limit} chars]`
}

interface Turn {
  /** The opening human user-text message of this turn. */
  userText: string
  /** Every entry between this user-text and the next, in JSONL order. */
  body: JsonlMessageEntry[]
}

/**
 * Walk the JSONL and split into "turns". A turn starts at each human
 * user-text and absorbs every subsequent user/assistant entry until the
 * next human user-text. Compact-summary entries (ours) are ignored
 * entirely so we never recursively summarize our own summaries.
 */
function parseTurns(entries: JsonlEntry[]): Turn[] {
  const turns: Turn[] = []
  let current: Turn | null = null
  for (const entry of entries) {
    if (entry.type !== 'user' && entry.type !== 'assistant') continue
    const e = entry as JsonlMessageEntry
    if (e.isCompactSummary) continue

    if (isHumanUserText(e)) {
      if (current) turns.push(current)
      current = { userText: extractUserTextString(e), body: [] }
    } else if (current) {
      current.body.push(e)
    }
    // Entries before the first user-text are ignored — there's no turn
    // to attach them to and they're rare (usually just init noise).
  }
  if (current) turns.push(current)
  return turns
}

function formatOlderTurnBody(body: JsonlMessageEntry[]): string[] {
  const lines: string[] = []
  let droppedRunPending = false
  const flushPlaceholder = () => {
    if (droppedRunPending) {
      lines.push(TOOL_PLACEHOLDER)
      droppedRunPending = false
    }
  }
  for (const entry of body) {
    if (entry.type === 'assistant') {
      const text = extractAssistantTextString(entry)
      const blocks = getBlocks(entry)
      const hasToolUse = blocks.some(
        (b) => (b as { type?: string }).type === 'tool_use'
      )
      if (text) {
        flushPlaceholder()
        lines.push(`Assistant: ${text}`)
      }
      if (hasToolUse) droppedRunPending = true
    } else if (entry.type === 'user') {
      // user-with-tool_result in this slot
      droppedRunPending = true
    }
  }
  flushPlaceholder()
  return lines
}

function formatRecentTurnBody(body: JsonlMessageEntry[]): string[] {
  const lines: string[] = []
  for (const entry of body) {
    const blocks = getBlocks(entry)
    if (entry.type === 'assistant') {
      for (const block of blocks) {
        const b = block as {
          type?: string
          text?: string
          name?: string
          input?: unknown
        }
        if (b.type === 'text' && typeof b.text === 'string') {
          lines.push(`Assistant: ${b.text}`)
        } else if (b.type === 'tool_use') {
          let input: string
          try { input = JSON.stringify(b.input ?? {}) } catch { input = '{}' }
          lines.push(`[tool_use: ${b.name ?? 'unknown'}] ${input}`)
        }
      }
    } else if (entry.type === 'user') {
      for (const block of blocks) {
        const b = block as ToolResultBlock & { type?: string }
        if (b.type !== 'tool_result') continue
        const text = stringifyToolResultContent(b.content).trim()
        if (!text) continue
        lines.push(`[tool_result] ${truncate(text, TOOL_RESULT_MAX_CHARS)}`)
      }
    }
  }
  return lines
}

function formatSummary(turns: Turn[], keepTurns: number): string {
  const lines: string[] = []
  lines.push(
    '[auto-time-compact] Conversation history. Older tool I/O is elided ' +
      `("${TOOL_PLACEHOLDER}"); the most recent ${keepTurns} user turn(s) ` +
      'are kept verbatim with tool details.'
  )
  if (turns.length === 0) return lines.join('\n')

  const cutoff = Math.max(0, turns.length - keepTurns)
  const older = turns.slice(0, cutoff)
  const recent = turns.slice(cutoff)

  for (const turn of older) {
    lines.push('')
    if (turn.userText) lines.push(`User: ${turn.userText}`)
    lines.push(...formatOlderTurnBody(turn.body))
  }
  for (const turn of recent) {
    lines.push('')
    if (turn.userText) lines.push(`User: ${turn.userText}`)
    lines.push(...formatRecentTurnBody(turn.body))
  }
  return lines.join('\n')
}

function makeBoundary(sessionId: string, logicalParentUuid: string | null) {
  return {
    parentUuid: logicalParentUuid,
    logicalParentUuid,
    isSidechain: false,
    type: 'system',
    subtype: 'compact_boundary',
    content: 'Conversation compacted (auto, time-based)',
    isMeta: false,
    timestamp: new Date().toISOString(),
    uuid: randomUUID(),
    level: 'info',
    compactMetadata: { trigger: 'auto', preTokens: 0 },
    compact_metadata: { trigger: 'auto', pre_tokens: 0 },
    sessionContextMetadata: { strategy: STRATEGY },
    userType: 'external',
    entrypoint: ENTRYPOINT_TAG,
    cwd: '/workspace',
    sessionId,
    version: APP_VERSION,
    gitBranch: 'HEAD',
    slug: ENTRYPOINT_TAG,
  }
}

function makeSummaryEntry(
  sessionId: string,
  boundaryUuid: string,
  summary: string
) {
  return {
    parentUuid: boundaryUuid,
    isSidechain: false,
    promptId: randomUUID(),
    type: 'user',
    message: { role: 'user', content: summary },
    uuid: randomUUID(),
    timestamp: new Date(Date.now() + 1).toISOString(),
    isCompactSummary: true,
    isVisibleInTranscriptOnly: true,
    userType: 'external',
    entrypoint: ENTRYPOINT_TAG,
    cwd: '/workspace',
    sessionId,
    version: APP_VERSION,
    gitBranch: 'HEAD',
    slug: ENTRYPOINT_TAG,
  }
}

function countToolUsesInAssistant(entry: JsonlMessageEntry): number {
  if (entry.type !== 'assistant') return 0
  let count = 0
  for (const block of getBlocks(entry)) {
    if ((block as { type?: string }).type === 'tool_use') count++
  }
  return count
}

/**
 * Count fresh activity since the latest boundary. Returns
 * { newUserText, newToolUses } using timestamp comparison so the
 * trailing copies / pre-boundary entries don't contribute.
 */
function countFreshActivity(
  entries: JsonlEntry[],
  latestBoundaryTimestamp: string | null
): { newUserText: number; newToolUses: number } {
  let newUserText = 0
  let newToolUses = 0
  for (const entry of entries) {
    const ts = (entry as { timestamp?: string }).timestamp
    if (latestBoundaryTimestamp && (!ts || ts <= latestBoundaryTimestamp)) continue
    if (isHumanUserText(entry)) newUserText++
    if (entry.type === 'assistant') {
      newToolUses += countToolUsesInAssistant(entry as JsonlMessageEntry)
    }
  }
  return { newUserText, newToolUses }
}

export async function advanceAutoTimeCompact(
  agentSlug: string,
  sessionId: string,
  keepTurns: number
): Promise<boolean> {
  const tag = `[AutoTimeCompact] ${agentSlug}/${sessionId}`
  const jsonlPath = getSessionJsonlPath(agentSlug, sessionId)

  const entries = await readJsonlFile<JsonlEntry>(jsonlPath)
  if (entries.length === 0) return false

  // Trigger gate. We only burn a boundary when there's been real activity
  // since the last one — at least one human input and a chunk of tool I/O
  // (tool I/O is where the token cost actually piles up).
  const latestBoundaryIdx = findLatestBoundaryIndex(entries)
  const latestBoundaryTimestamp =
    latestBoundaryIdx >= 0
      ? ((entries[latestBoundaryIdx] as { timestamp?: string }).timestamp ?? null)
      : null

  const { newUserText, newToolUses } = countFreshActivity(
    entries,
    latestBoundaryTimestamp
  )
  if (newUserText < MIN_NEW_USER_TEXT) return false
  if (newToolUses <= MIN_NEW_TOOL_USES) return false

  // Build summary by re-parsing the whole JSONL (compact-summary entries
  // are skipped inside parseTurns, so we never feed our own summaries back
  // into themselves).
  const turns = parseTurns(entries)
  const summary = formatSummary(turns, keepTurns)

  const tailUuid = (entries[entries.length - 1] as { uuid?: string }).uuid
  if (!tailUuid) return false

  const boundary = makeBoundary(sessionId, tailUuid)
  const summaryEntry = makeSummaryEntry(sessionId, boundary.uuid, summary)
  const lines = [JSON.stringify(boundary), JSON.stringify(summaryEntry)]
  await fs.promises.appendFile(
    jsonlPath,
    lines.map((l) => l + '\n').join(''),
    'utf-8'
  )

  messagePersister.broadcastMessagesUpdated(sessionId)

  // Force the agent-container SDK to drop its in-memory message chain so
  // the boundary we just appended actually takes effect on the next user
  // message. Without this, the SDK's running Query keeps the
  // pre-compaction chain in memory and never re-reads JSONL — the user
  // would type a new message and the model would still see the entire
  // un-compacted history. Interrupting the Query aborts the for-await
  // pump (even when no request is in flight, isProcessing is true while
  // it's waiting on the input queue), flips isReady=false, and the next
  // sendMessage triggers a fresh query({ resume }) that re-reads the
  // JSONL — at which point the SDK's compact_boundary truncation kicks
  // in. See agent-container/src/claude-code.ts:interrupt + sendMessage.
  try {
    const client = containerManager.getClient(agentSlug)
    await client.interruptSession(sessionId)
  } catch (err) {
    // Container may be gone (sleep, restart, etc.) — JSONL is already
    // updated, so the next time the container comes up with this session
    // it'll resume cleanly from the new boundary.
    console.warn(`${tag} interruptSession failed (non-fatal):`, err)
  }

  console.log(
    `${tag} compacted: turns=${turns.length} keepTurns=${keepTurns} ` +
      `newUserText=${newUserText} newToolUses=${newToolUses} ` +
      `summaryChars=${summary.length}`
  )
  return true
}
