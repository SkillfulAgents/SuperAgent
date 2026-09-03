export interface DeliverFileInput {
  filePath?: string
  description?: string
}

function parseInput(input: unknown): DeliverFileInput {
  return typeof input === 'object' && input !== null ? (input as DeliverFileInput) : {}
}

export function getFilename(filePath: string): string {
  return filePath.split('/').pop() || filePath
}

function getSummary(input: unknown): string | null {
  const { filePath } = parseInput(input)
  return filePath ? getFilename(filePath) : null
}

/**
 * Byte size reported by the in-container tool result, e.g.
 * `File "out/report.pdf" (12345 bytes) has been delivered…`. The result is the
 * only record of the size at delivery time, so the renderer reads it from here
 * rather than re-stat'ing the workspace. Undefined when the result is missing,
 * errored, or not in the expected shape.
 */
export function getDeliveredFileSize(result: unknown): number | undefined {
  const text = resultText(result)
  if (!text) return undefined
  const match = /\((?:size: )?(\d+) bytes\)/.exec(text)
  return match ? Number(match[1]) : undefined
}

/**
 * Tool results reach the renderer either as a plain string (mock client,
 * stdout-style results) or as the SDK's content-block array
 * (`[{ type: 'text', text }]`) once persisted from the transcript.
 */
function resultText(result: unknown): string {
  if (typeof result === 'string') return result
  if (Array.isArray(result)) {
    return result
      .map((block) => (block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string'
        ? (block as { text: string }).text
        : ''))
      .join('\n')
  }
  return ''
}

export const deliverFileDef = { displayName: 'Deliver File', parseInput, getSummary } as const
