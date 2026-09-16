import type { JsonlMessageEntry, JsonlSystemEntry } from '@shared/lib/types/agent'
import { deliverFileInputSchema } from '@shared/lib/tool-definitions/deliver-file-schema'
import { getDeliveredFileMetadata } from '@shared/lib/tool-definitions/deliver-file'
import { sanitizeUploadFilename } from '@shared/lib/utils/path-safety'
import { transformMessages } from '@shared/lib/utils/message-transform'

export type TranscriptMessage = {
  role: string
  content: string
  toolName?: string
}

export type CompactedMessage = TranscriptMessage & {
  spoken: string
}

export interface DeliveredAgentFile {
  /** Stable authorization lookup key; filename is display metadata only. */
  deliveryId: string
  filename: string
  description?: string
  sizeBytes: number
  sha256?: string
}

export interface ResolvedDeliveredAgentFile extends DeliveredAgentFile {
  filePath: string
}

const DELIVER_FILE_TOOL = 'mcp__user-input__deliver_file'

/** Project completed file deliveries from the full persisted transcript. */
function collectResolvedDeliveredFiles(
  entries: Array<JsonlMessageEntry | JsonlSystemEntry>,
): ResolvedDeliveredAgentFile[] {
  const delivered: ResolvedDeliveredAgentFile[] = []
  const seenDeliveryIds = new Set<string>()

  for (const item of transformMessages(entries)) {
    if (item.type !== 'assistant') continue

    for (const toolCall of item.toolCalls) {
      if (
        toolCall.name !== DELIVER_FILE_TOOL ||
        toolCall.isError !== false ||
        seenDeliveryIds.has(toolCall.id)
      ) continue

      const input = deliverFileInputSchema.safeParse(toolCall.input)
      if (!input.success) continue

      const metadata = getDeliveredFileMetadata((toolCall as { result?: unknown }).result)
      if (!metadata) continue

      seenDeliveryIds.add(toolCall.id)
      delivered.push({
        deliveryId: toolCall.id,
        filePath: input.data.filePath,
        filename: sanitizeUploadFilename(input.data.filePath),
        ...(input.data.description !== undefined ? { description: input.data.description } : {}),
        sizeBytes: metadata.sizeBytes,
        ...(metadata.sha256 ? { sha256: metadata.sha256 } : {}),
      })
    }
  }

  return delivered
}

export function collectDeliveredFiles(
  entries: Array<JsonlMessageEntry | JsonlSystemEntry>,
): DeliveredAgentFile[] {
  return collectResolvedDeliveredFiles(entries).map(({ filePath: _filePath, ...file }) => file)
}

export function findDeliveredFile(
  entries: Array<JsonlMessageEntry | JsonlSystemEntry>,
  deliveryId: string,
): ResolvedDeliveredAgentFile | undefined {
  return collectResolvedDeliveredFiles(entries).find((file) => file.deliveryId === deliveryId)
}

const INTERNAL_STUB: TranscriptMessage = {
  role: 'system',
  content: 'tool calls + thinking',
}

/**
 * Convert a JSONL message entry into a compact { role, content, spoken } shape.
 * Strips internal SDK fields. `content` is today's compact view (tool stubs
 * kept). `spoken` is text-only, empty when the entry was only tools/thinking.
 */
export function compactMessage(entry: JsonlMessageEntry | JsonlSystemEntry): CompactedMessage | null {
  if (entry.type === 'system') {
    const content = entry.subtype === 'compact_boundary'
      ? '[context compacted]'
      : `[system: ${entry.subtype ?? 'unknown'}]`
    return { role: 'system', content, spoken: content }
  }
  const msg = entry.message
  if (typeof msg.content === 'string') {
    return { role: entry.type, content: msg.content, spoken: msg.content }
  }
  const parts: string[] = []
  const spokenParts: string[] = []
  let firstToolName: string | undefined
  let hadThinking = false
  for (const block of msg.content) {
    if (block.type === 'text') {
      parts.push(block.text)
      spokenParts.push(block.text)
    } else if (block.type === 'tool_use') {
      firstToolName = firstToolName ?? block.name
      parts.push(`[tool_use: ${block.name}]`)
    } else if (block.type === 'tool_result') {
      const text = Array.isArray(block.content)
        ? block.content
            .filter((p) => p && typeof p === 'object' && 'text' in p)
            .map((p) => (p as { text: string }).text)
            .join('\n')
        : typeof block.content === 'string'
          ? block.content
          : ''
      parts.push(text ? `[tool_result] ${text}` : '[tool_result]')
    } else if (block.type === 'thinking') {
      hadThinking = true
    }
  }
  let content = parts.join('\n').trim()
  if (!content) {
    content = hadThinking ? '[thinking only — no text response]' : '[no text response]'
  }
  return {
    role: entry.type,
    content,
    spoken: spokenParts.join('\n').trim(),
    ...(firstToolName ? { toolName: firstToolName } : {}),
  }
}

export function toTranscriptView(
  compacted: CompactedMessage[],
  fullTranscript: boolean,
): TranscriptMessage[] {
  if (fullTranscript) {
    return compacted.map(({ role, content, toolName }) => ({
      role,
      content,
      ...(toolName ? { toolName } : {}),
    }))
  }
  const out: TranscriptMessage[] = []
  let pendingInternal = false
  for (const message of compacted) {
    if (message.spoken.length > 0) {
      if (pendingInternal) {
        out.push(INTERNAL_STUB)
        pendingInternal = false
      }
      out.push({ role: message.role, content: message.spoken })
      continue
    }
    pendingInternal = true
  }
  if (pendingInternal) {
    out.push(INTERNAL_STUB)
  }
  return out
}

export function pageTranscript(
  entries: Array<JsonlMessageEntry | JsonlSystemEntry>,
  opts: { fullTranscript?: boolean; limit?: number } = {},
): { messages: TranscriptMessage[]; total: number } {
  const compacted = entries
    .map(compactMessage)
    .filter((message): message is CompactedMessage => message !== null)
  const view = toTranscriptView(compacted, opts.fullTranscript === true)
  return {
    messages: opts.limit ? view.slice(-opts.limit) : view,
    total: view.length,
  }
}
