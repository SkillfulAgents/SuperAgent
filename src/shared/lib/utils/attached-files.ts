const MARKER = '[Attached files:]'

/**
 * Append an attached files block to a message.
 * If the message already has content, a blank line separates it from the block.
 */
export function appendAttachedFiles(message: string, filePaths: string[]): string {
  if (filePaths.length === 0) return message
  const block = `${MARKER}\n${filePaths.map((p) => `- ${p}`).join('\n')}`
  return message ? `${message}\n\n${block}` : block
}

/**
 * Parse an "[Attached files:]" section from message text.
 * Returns the message text without the attached files block, and the list of file paths.
 */
export function parseAttachedFiles(text: string): { cleanText: string; attachedFiles: string[] } {
  const markerIndex = text.indexOf(MARKER)
  if (markerIndex === -1) return { cleanText: text, attachedFiles: [] }

  const before = text.slice(0, markerIndex).trimEnd()
  const after = text.slice(markerIndex + MARKER.length)

  const files: string[] = []
  const lines = after.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const match = trimmed.match(/^-\s+(.+)$/)
    if (match) {
      files.push(match[1])
    } else {
      break
    }
  }

  return { cleanText: before, attachedFiles: files }
}
