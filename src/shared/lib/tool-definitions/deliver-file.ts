import { getPathName } from '@shared/lib/utils/workspace-path'
import {
  deliverFileResultBlocksSchema,
  deliveredFileSchema,
  type DeliveredFile,
} from './deliver-file-schema'

export interface DeliverFileInput {
  filePath?: string
  description?: string
}

function parseInput(input: unknown): DeliverFileInput {
  return typeof input === 'object' && input !== null ? (input as DeliverFileInput) : {}
}

function getSummary(input: unknown): string | null {
  const { filePath } = parseInput(input)
  return filePath ? getPathName(filePath) : null
}

/** The machine-readable line the container appends; see deliver-file-schema.ts. */
const DELIVERED_LINE = /^Delivered: (\{.*\})$/m

/**
 * Size from a transcript written before the `Delivered:` line existed, when the
 * byte count lived only in the sentence. Anchored on the closing quote of the
 * path and the words that follow it, so a filename that itself contains
 * "(12 bytes)" cannot be mistaken for the size.
 */
const LEGACY_SIZE_LINE = /" \((\d+) bytes\) has been delivered/

function flattenResultText(result: unknown): string | undefined {
  if (typeof result === 'string') {
    try {
      const blocks = deliverFileResultBlocksSchema.parse(JSON.parse(result))
      return flattenResultText(blocks)
    } catch {
      return result
    }
  }

  try {
    const blocks = deliverFileResultBlocksSchema.parse(result)
    const text = blocks
      .filter((block) => block.type === 'text' && block.text)
      .map((block) => block.text)
      .join('\n')
    return text || undefined
  } catch {
    return undefined
  }
}

/**
 * Byte size of a delivered file, at the moment it was delivered. Read from the
 * result's `Delivered:` line, falling back to the prose for older transcripts.
 * Undefined when the result is missing, errored, or carries neither.
 *
 * Accepts the persisted result shapes emitted by transcript transformation:
 * plain text, JSON-encoded content blocks, or an MCP content-block array.
 */
export function getDeliveredFileMetadata(result: unknown): DeliveredFile | undefined {
  const resultText = flattenResultText(result)
  if (!resultText) return undefined

  const line = DELIVERED_LINE.exec(resultText)
  if (line) {
    try {
      return deliveredFileSchema.parse(JSON.parse(line[1]))
    } catch {
      // Malformed JSON on the contract line: fall through to the prose.
    }
  }

  const legacy = LEGACY_SIZE_LINE.exec(resultText)
  return legacy ? { sizeBytes: Number(legacy[1]) } : undefined
}

export function getDeliveredFileSize(result: unknown): number | undefined {
  return getDeliveredFileMetadata(result)?.sizeBytes
}

export const deliverFileDef = { displayName: 'Deliver File', parseInput, getSummary } as const
