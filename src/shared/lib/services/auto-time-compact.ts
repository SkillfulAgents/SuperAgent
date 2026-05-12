/**
 * V0 recency compact (no LLM). Append [compact_boundary, summary] to JSONL
 * tail; SDK resume (sdk.mjs `hasPreservedSegment` branch) drops everything
 * before the boundary, so the API context becomes [system, summary] only.
 * Summary keeps user/assistant text verbatim and the most recent K tool
 * calls inline; older tool I/O collapses to `[...]`. After append we
 * `interruptSession` so the SDK reloads JSONL on the next user message.
 */

import * as fs from 'fs'
import { randomUUID } from 'crypto'
import { APP_VERSION } from '@shared/lib/config/version'
import { containerManager } from '@shared/lib/container/container-manager'
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
const TOOL_RESULT_MAX_CHARS = 8_000
const TOOL_PLACEHOLDER = '[...]'
// Trigger gate: only burn a boundary when real activity has accumulated.
const MIN_NEW_USER_TEXT = 1
const MIN_NEW_TOOL_USES = 10

type Untyped = { type?: string }

const isBoundary = (e?: JsonlEntry) => {
  const x = e as { type?: string; subtype?: string } | undefined
  return x?.type === 'system' && x.subtype === 'compact_boundary'
}

const isSynthetic = (m: JsonlMessageEntry) =>
  m.type === 'assistant' && (m.message as { model?: string } | undefined)?.model === '<synthetic>'

function getBlocks(m: JsonlMessageEntry): ContentBlock[] {
  const c = m.message?.content
  if (typeof c === 'string') return [{ type: 'text', text: c } as ContentBlock]
  return Array.isArray(c) ? (c as ContentBlock[]) : []
}

function isHumanUserText(e?: JsonlEntry): boolean {
  const m = e as JsonlMessageEntry | undefined
  if (!m || m.type !== 'user' || m.isCompactSummary) return false
  return !getBlocks(m).some((b) => (b as Untyped).type === 'tool_result')
}

const joinTextBlocks = (m: JsonlMessageEntry): string =>
  getBlocks(m)
    .map((b) => b as { type?: string; text?: string })
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text!)
    .join('\n')
    .trim()

function stringifyToolResult(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) {
    try { return JSON.stringify(content) } catch { return String(content) }
  }
  return content
    .map((b) => {
      const x = b as Untyped & { text?: string }
      if (x.type === 'text' && typeof x.text === 'string') return x.text
      if (x.type === 'image') return '[image]'
      try { return JSON.stringify(b) } catch { return String(b) }
    })
    .join('\n')
}

const truncate = (text: string, limit: number) =>
  text.length <= limit ? text : `${text.slice(0, limit)}… [truncated ${text.length - limit} chars]`

/**
 * Build the transcript-style summary string.
 *
 * - All human user-text and assistant text is preserved verbatim.
 * - Tool I/O is sliced by recency: only the most recent `keepLastTools`
 *   tool_use calls (and their paired tool_result entries) are emitted in
 *   full. Older tool_use/tool_result blocks collapse into a single
 *   `[...]` placeholder per contiguous run.
 *
 * Walking the JSONL once linearly is enough — we just have to know up
 * front which tool_use IDs are "recent" so we can route their result
 * counterparts the same way.
 */
/**
 * Walk entries once linearly. Pre-pass picks the most recent K tool_use
 * IDs; tool_result blocks are routed via tool_use_id (not stream position)
 * so a paired call shares the kept/dropped fate of its tool_use.
 */
export function formatSummary(entries: JsonlEntry[], keepLastTools: number): string {
  const toolIds: string[] = []
  for (const e of entries) {
    const m = e as JsonlMessageEntry
    if (m.type !== 'assistant' || isSynthetic(m)) continue
    for (const b of getBlocks(m)) {
      const x = b as Untyped & { id?: string }
      if (x.type === 'tool_use' && x.id) toolIds.push(x.id)
    }
  }
  const kept = new Set(toolIds.slice(Math.max(0, toolIds.length - keepLastTools)))

  const lines: string[] = [
    `[auto-time-compact] Conversation transcript. The most recent ${keepLastTools} tool call(s) are kept verbatim; older tool I/O is elided as "${TOOL_PLACEHOLDER}".`,
  ]
  let pending = false
  const flush = () => { if (pending) { lines.push(TOOL_PLACEHOLDER); pending = false } }
  const emit = (line: string) => { flush(); lines.push(line) }

  for (const entry of entries) {
    if (entry.type !== 'user' && entry.type !== 'assistant') continue
    const m = entry as JsonlMessageEntry
    if (m.isCompactSummary || isSynthetic(m)) continue

    const blocks = getBlocks(m)
    if (m.type === 'user') {
      const isToolResult = blocks.some((b) => (b as Untyped).type === 'tool_result')
      if (!isToolResult) {
        const text = joinTextBlocks(m)
        if (text) { flush(); lines.push(''); lines.push(`User: ${text}`) }
        continue
      }
      for (const b of blocks) {
        const x = b as Untyped & { tool_use_id?: string }
        if (x.type !== 'tool_result') continue
        if (x.tool_use_id && kept.has(x.tool_use_id)) {
          const text = stringifyToolResult((b as ToolResultBlock).content).trim()
          if (text) emit(`[tool_result] ${truncate(text, TOOL_RESULT_MAX_CHARS)}`)
        } else {
          pending = true
        }
      }
      continue
    }
    // assistant
    for (const b of blocks) {
      const x = b as Untyped & { text?: string; id?: string; name?: string; input?: unknown }
      if (x.type === 'text' && typeof x.text === 'string') {
        emit(`Assistant: ${x.text}`)
      } else if (x.type === 'tool_use') {
        if (x.id && kept.has(x.id)) {
          let input: string
          try { input = JSON.stringify(x.input ?? {}) } catch { input = '{}' }
          emit(`[tool_use: ${x.name ?? 'unknown'}] ${input}`)
        } else {
          pending = true
        }
      }
    }
  }
  flush()
  return lines.join('\n')
}

function makeBoundary(sessionId: string, parentUuid: string | null) {
  return {
    parentUuid,
    logicalParentUuid: parentUuid,
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

function makeSummaryEntry(sessionId: string, boundaryUuid: string, summary: string) {
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
 * Single linear scan: find the most recent compact_boundary's timestamp,
 * and count fresh activity (human user-text + assistant tool_use) that
 * landed after it.
 */
function scanForGate(entries: JsonlEntry[]) {
  let latestBoundaryTs: string | null = null
  for (let i = entries.length - 1; i >= 0; i--) {
    if (isBoundary(entries[i])) {
      latestBoundaryTs = (entries[i] as { timestamp?: string }).timestamp ?? null
      break
    }
  }
  let newUserText = 0
  let newToolUses = 0
  for (const e of entries) {
    const ts = (e as { timestamp?: string }).timestamp
    if (latestBoundaryTs && (!ts || ts <= latestBoundaryTs)) continue
    if (isHumanUserText(e)) newUserText++
    if (e.type === 'assistant') {
      for (const b of getBlocks(e as JsonlMessageEntry)) {
        if ((b as Untyped).type === 'tool_use') newToolUses++
      }
    }
  }
  return { newUserText, newToolUses }
}

export async function advanceAutoTimeCompact(
  agentSlug: string,
  sessionId: string,
  keepLastTools: number
): Promise<boolean> {
  const tag = `[AutoTimeCompact] ${agentSlug}/${sessionId}`
  const jsonlPath = getSessionJsonlPath(agentSlug, sessionId)

  const entries = await readJsonlFile<JsonlEntry>(jsonlPath)
  if (entries.length === 0) return false

  const { newUserText, newToolUses } = scanForGate(entries)
  if (newUserText < MIN_NEW_USER_TEXT) return false
  if (newToolUses <= MIN_NEW_TOOL_USES) return false

  const tailUuid = (entries[entries.length - 1] as { uuid?: string }).uuid
  if (!tailUuid) return false

  const summary = formatSummary(entries, keepLastTools)
  const boundary = makeBoundary(sessionId, tailUuid)
  const summaryEntry = makeSummaryEntry(sessionId, boundary.uuid, summary)
  await fs.promises.appendFile(
    jsonlPath,
    [JSON.stringify(boundary), JSON.stringify(summaryEntry)].map((l) => l + '\n').join(''),
    'utf-8'
  )

  // Drop the SDK's in-memory chain so the next user message restarts the
  // Query and re-reads JSONL with our boundary in place.
  try {
    await containerManager.getClient(agentSlug).interruptSession(sessionId)
  } catch (err) {
    console.warn(`${tag} interruptSession failed (non-fatal):`, err)
  }

  console.log(
    `${tag} compacted: entries=${entries.length} keep=${keepLastTools} ` +
      `newUserText=${newUserText} newToolUses=${newToolUses} chars=${summary.length}`
  )
  return true
}
