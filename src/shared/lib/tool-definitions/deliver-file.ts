import { getPathName } from '@shared/lib/utils/workspace-path'
import { deliveredFileSchema } from './deliver-file-schema'

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

/**
 * Byte size of a delivered file, at the moment it was delivered. Read from the
 * result's `Delivered:` line, falling back to the prose for older transcripts.
 * Undefined when the result is missing, errored, or carries neither.
 *
 * Takes the already-flattened result text: callers in the renderer get that
 * from `parseToolResult`, which is the one place that knows every shape a tool
 * result arrives in.
 */
export function getDeliveredFileSize(resultText: string | null | undefined): number | undefined {
  if (!resultText) return undefined

  const line = DELIVERED_LINE.exec(resultText)
  if (line) {
    try {
      const parsed = deliveredFileSchema.safeParse(JSON.parse(line[1]))
      if (parsed.success) return parsed.data.sizeBytes
    } catch {
      // Malformed JSON on the contract line: fall through to the prose.
    }
  }

  const legacy = LEGACY_SIZE_LINE.exec(resultText)
  return legacy ? Number(legacy[1]) : undefined
}

export const deliverFileDef = { displayName: 'Deliver File', parseInput, getSummary } as const
