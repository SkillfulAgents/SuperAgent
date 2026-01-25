/**
 * Message Transform Utilities
 *
 * Transforms JSONL message entries from Claude SDK format to API response format.
 * Handles merging of streaming message chunks and attaching tool results.
 */

import { ContentBlock, JsonlMessageEntry } from '@shared/lib/types/agent'

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
  }>
  createdAt: Date
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
 * Transform JSONL messages to API response format
 *
 * This handles several complexities of the Claude SDK JSONL format:
 * 1. Assistant messages are streamed as separate entries with the same message.id
 *    - First entry might have just text, second entry has tool_use, etc.
 *    - We merge these into a single message
 * 2. Tool results come as separate user messages with tool_result content
 *    - We attach these results to the corresponding tool_use in the assistant message
 * 3. Empty string results (e.g., mkdir with no output) should be preserved as valid results
 */
export function transformMessages(entries: JsonlMessageEntry[]): TransformedMessage[] {
  // Merge assistant messages by message.id
  // Claude SDK writes separate entries for each content block (text, tool_use, etc.)
  // with the same message.id but different UUIDs. We need to merge them into one message.
  const mergedEntries: JsonlMessageEntry[] = []
  const assistantMessageIds = new Map<string, number>() // message.id -> index in mergedEntries

  for (const entry of entries) {
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

  for (const entry of entries) {
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

  // Second pass: transform messages, attaching results to tool calls
  const result: TransformedMessage[] = []

  for (const entry of mergedEntries) {
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
          toolCalls.push({
            id: block.id,
            name: block.name,
            input: block.input,
            result: resultContent,
            isError: toolResult?.isError,
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

  return result
}
