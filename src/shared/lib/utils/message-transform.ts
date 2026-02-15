/**
 * Message Transform Utilities
 *
 * Transforms JSONL message entries from Claude SDK format to API response format.
 * Handles merging of streaming message chunks and attaching tool results.
 */

import { ContentBlock, JsonlMessageEntry, JsonlSystemEntry } from '@shared/lib/types/agent'

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
}

export interface TransformedCompactBoundary {
  id: string
  type: 'compact_boundary'
  summary: string
  trigger: string
  preTokens?: number
  createdAt: Date
}

export type TransformedItem = TransformedMessage | TransformedCompactBoundary

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
  // Pre-pass: identify compact boundaries and pair them with their summary messages
  const compactBoundaries = new Map<number, { boundary: JsonlSystemEntry; summaryContent: string }>()
  const skipIndices = new Set<number>()

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (entry.type === 'system' && (entry as JsonlSystemEntry).subtype === 'compact_boundary') {
      const sysEntry = entry as JsonlSystemEntry
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

  // Filter to only message entries for the main transform pipeline
  const messageEntries: JsonlMessageEntry[] = []

  for (let i = 0; i < entries.length; i++) {
    if (skipIndices.has(i)) continue
    const entry = entries[i]
    if (entry.type === 'user' || entry.type === 'assistant') {
      messageEntries.push(entry as JsonlMessageEntry)
    }
  }

  // Merge assistant messages by message.id
  // Claude SDK writes separate entries for each content block (text, tool_use, etc.)
  // with the same message.id but different UUIDs. We need to merge them into one message.
  const mergedEntries: JsonlMessageEntry[] = []
  const assistantMessageIds = new Map<string, number>() // message.id -> index in mergedEntries

  for (const entry of messageEntries) {
    const messageId = entry.message.id
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
      }
    } else {
      // User messages or messages without id - keep as-is
      mergedEntries.push(entry)
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

  // Build a map of message UUID -> compact boundary that precedes it
  // This allows us to insert boundaries at the correct position in the output
  const boundaryBeforeUuid = new Map<string, TransformedCompactBoundary>()
  // Also track boundaries that appear at the very end (no following message)
  const trailingBoundaries: TransformedCompactBoundary[] = []

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

  // Transform merged message entries, inserting boundaries at correct positions
  const result: TransformedItem[] = []

  for (const entry of mergedEntries) {
    // Insert any compact boundary that precedes this message
    const boundary = boundaryBeforeUuid.get(entry.uuid)
    if (boundary) {
      result.push(boundary)
    }

    // Skip user messages that only contain tool results
    if (isToolResultOnlyMessage(entry)) continue

    const content = entry.message.content
    let text = ''
    const toolCalls: TransformedMessage['toolCalls'] = []

    if (typeof content === 'string') {
      text = content
    } else if (Array.isArray(content)) {
      for (const block of content as ContentBlock[]) {
        if (block.type === 'text') {
          text += block.text
        } else if (block.type === 'tool_use') {
          const toolResult = toolResults.get(block.id)
          // Use toolUseResult.stdout if available, otherwise use content
          // Use ?? instead of || to preserve empty string as valid result (e.g., mkdir has no output)
          const resultContent =
            toolResult?.toolUseResult?.stdout ?? toolResult?.content ?? undefined

          const subagent = (block.name === 'Task' && toolResult?.toolUseResult?.agentId)
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

    result.push({
      id: entry.uuid,
      type: entry.type,
      content: { text },
      toolCalls,
      createdAt: new Date(entry.timestamp),
    })
  }

  // Append any boundaries that appear after all messages
  result.push(...trailingBoundaries)

  return result
}
