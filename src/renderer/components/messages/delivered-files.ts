import { deliverFileDef, getDeliveredFileSize } from '@shared/lib/tools/deliver-file/definition'
import { parseToolResult } from '@renderer/lib/parse-tool-result'
import type { ApiMessageOrBoundary, ApiToolCall } from '@shared/lib/types/api'
import { isTurnStartingUserMessage } from './pending-message'

export interface DeliveredFile {
  /** The deliver_file tool call's id: differs for each delivery of one path, so its image URL changes too. */
  id: string
  filePath: string
  description?: string
  sizeBytes?: number
}

/** The file a tool call delivers, or null for any other call and for a delivery that failed. */
function deliveredBy(tc: ApiToolCall): DeliveredFile | null {
  if (tc.name !== 'mcp__user-input__deliver_file' || tc.isError) return null
  const { filePath, description } = deliverFileDef.parseInput(tc.input)
  if (!filePath) return null
  return { id: tc.id, filePath, description, sizeBytes: getDeliveredFileSize(parseToolResult(tc.result).text) }
}

/** Every delivery in the transcript, oldest first, including the running turn's. */
export function collectDeliveries(messages: ApiMessageOrBoundary[]): DeliveredFile[] {
  return messages.flatMap(msg => (msg.type === 'assistant' ? msg.toolCalls.flatMap(tc => deliveredBy(tc) ?? []) : []))
}

/** Files delivered in each turn, keyed by the turn's last assistant message id. */
export function collectTurnDeliveredFiles(
  messages: ApiMessageOrBoundary[],
  lastTurnComplete: boolean,
): Map<string, DeliveredFile[]> {
  const filesMap = new Map<string, DeliveredFile[]>()
  let turnFiles: DeliveredFile[] = []
  let lastAssistantMessageId: string | null = null

  for (const msg of messages) {
    if (isTurnStartingUserMessage(msg)) {
      if (lastAssistantMessageId && turnFiles.length > 0) {
        filesMap.set(lastAssistantMessageId, turnFiles)
      }
      turnFiles = []
      lastAssistantMessageId = null
    } else if (msg.type === 'assistant') {
      lastAssistantMessageId = msg.id
      for (const tc of msg.toolCalls) {
        const delivered = deliveredBy(tc)
        if (delivered) {
          // A re-delivered path is an updated version: show it once, as its latest delivery.
          turnFiles = turnFiles.filter((file) => file.filePath !== delivered.filePath)
          turnFiles.push(delivered)
        }
      }
    }
  }

  if (lastTurnComplete && lastAssistantMessageId && turnFiles.length > 0) {
    filesMap.set(lastAssistantMessageId, turnFiles)
  }

  return filesMap
}
