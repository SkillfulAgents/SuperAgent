/**
 * Auto Time-Based Compact (V0: recency-only, no LLM)
 *
 * Appends a synthetic SDK-native `compact_boundary` plus a paired
 * `isCompactSummary` user message to the JSONL tail. The SDK's resume
 * reader (see node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs around
 * the `hasPreservedSegment` branch) treats any compact_boundary without
 * `compactMetadata.preservedSegment` as a hard reset point: everything
 * read before that line is discarded, and the API request is built from
 * `[system_prompt, ...entries_after_boundary]` only.
 *
 * Recency = pure text concatenation. We pull the user-text and
 * assistant-text content from every entry written since the previous
 * boundary, prepend the previous summary so the running transcript stays
 * cumulative, and stuff the result into the new summary message. No
 * trailing entries are preserved verbatim — they don't need to be,
 * because the SDK's truncate-on-boundary semantics already discard
 * everything pre-boundary. This sidesteps every tool_use / tool_result
 * pairing concern at the API level.
 *
 * Triggered by auto-time-compact-coordinator. Off until the user enables
 * it via Settings > Runtime > Auto-Compact Idle Sessions.
 */

import * as fs from 'fs'
import { randomUUID } from 'crypto'
import { APP_VERSION } from '@shared/lib/config/version'
import { messagePersister } from '@shared/lib/container/message-persister'
import type { JsonlEntry, JsonlMessageEntry } from '@shared/lib/types/agent'
import {
  getSessionJsonlPath,
  readJsonlFile,
} from '@shared/lib/utils/file-storage'

const STRATEGY = 'time_recency'
const ENTRYPOINT_TAG = 'superagent-auto-time-compact'

function isCompactBoundaryEntry(entry: JsonlEntry | undefined): boolean {
  if (!entry) return false
  const e = entry as { type?: string; subtype?: string }
  return e.type === 'system' && e.subtype === 'compact_boundary'
}

/**
 * "Human user-text" = a message a real person typed. Excludes:
 *   - assistant entries
 *   - tool_result entries (also type=user, but content is a tool response)
 *   - our own compact-summary entries
 *
 * Used purely as a freshness signal: we only want to compact when the
 * conversation has accumulated enough genuine human input since the last
 * boundary — otherwise the coordinator's per-minute tick would keep
 * stamping boundaries onto an idle session forever.
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

/**
 * Pull the human-readable text out of a JSONL message entry. Returns null
 * for entries that contribute nothing useful (tool-only turns, file
 * snapshots, system entries, etc.). Skips tool_result blocks so we don't
 * dump megabytes of tool I/O into the summary.
 */
function extractText(entry: JsonlEntry): { role: 'user' | 'assistant'; text: string } | null {
  if (entry.type !== 'user' && entry.type !== 'assistant') return null
  const e = entry as JsonlMessageEntry
  if (e.isCompactSummary) return null
  const content = e.message?.content
  if (typeof content === 'string') {
    const text = content.trim()
    return text ? { role: e.type, text } : null
  }
  if (!Array.isArray(content)) return null
  const parts: string[] = []
  for (const block of content) {
    const b = block as { type?: string; text?: string }
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
  }
  const text = parts.join('\n').trim()
  return text ? { role: e.type, text } : null
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

/**
 * The entry right after a compact_boundary is the previous summary's user
 * message. Pull its content so the next summary can prepend it and stay
 * cumulative — successive boundaries truncate, so each summary must
 * carry forward everything earlier or the model loses history.
 */
function findPreviousSummaryContent(
  entries: JsonlEntry[],
  boundaryIdx: number
): string | null {
  if (boundaryIdx < 0) return null
  const next = entries[boundaryIdx + 1] as JsonlMessageEntry | undefined
  if (!next || next.type !== 'user' || !next.isCompactSummary) return null
  const content = next.message?.content
  return typeof content === 'string' ? content : null
}

export async function advanceAutoTimeCompact(
  agentSlug: string,
  sessionId: string,
  minNewHumanTurns: number
): Promise<boolean> {
  const tag = `[AutoTimeCompact] ${agentSlug}/${sessionId}`
  const jsonlPath = getSessionJsonlPath(agentSlug, sessionId)

  const entries = await readJsonlFile<JsonlEntry>(jsonlPath)
  if (entries.length === 0) return false

  // Freshness gate: only compact when there's enough new human input since
  // the previous boundary. Without this gate the coordinator's per-minute
  // tick would keep stamping new boundaries onto an idle session forever.
  const latestBoundaryIdx = findLatestBoundaryIndex(entries)
  const newContent = entries.slice(latestBoundaryIdx + 1)
  const newHumanTurns = newContent.filter(isHumanUserText).length
  if (newHumanTurns < minNewHumanTurns) return false

  // Cumulative summary: previous summary text + new conversation text.
  const previousSummary = findPreviousSummaryContent(entries, latestBoundaryIdx)
  const newTextLines: string[] = []
  for (const entry of newContent) {
    const t = extractText(entry)
    if (!t) continue
    const tagLabel = t.role === 'user' ? 'User' : 'Assistant'
    newTextLines.push(`${tagLabel}: ${t.text}`)
  }
  const newText = newTextLines.join('\n\n')
  const summary = previousSummary
    ? `${previousSummary}\n\n${newText}`
    : `[auto-time-compact] Conversation transcript (text-only):\n\n${newText}`

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

  // Tell SSE subscribers the file changed — without this the open chat
  // pane keeps rendering the pre-compaction view until something else
  // (a new message, a navigation, etc.) forces a refetch.
  messagePersister.broadcastMessagesUpdated(sessionId)

  console.log(
    `${tag} compacted: newHumanTurns=${newHumanTurns} ` +
      `prevSummaryChars=${previousSummary?.length ?? 0} ` +
      `summaryChars=${summary.length}`
  )
  return true
}
