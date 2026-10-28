const MARKER = '[Attached files:]'
const MOUNT_MARKER = '[Attached drives (read-write):]'
// Messages sent before the drive wording carry this tag.
const OLD_MOUNT_MARKER = '[Mounted folders (read-write):]'

/**
 * Append an attached files block to a message.
 * If the message already has content, a blank line separates it from the block.
 */
export function appendAttachedFiles(message: string, filePaths: string[]): string {
  if (filePaths.length === 0) return message
  const block = `${MARKER}\n${filePaths.map((p) => `- ${p}`).join('\n')}`
  return message ? `${message}\n\n${block}` : block
}

/** Where the last `marker` line starts, after a blank line or at the start, or -1. */
function blockStart(text: string, marker: string): number {
  const at = text.lastIndexOf(`\n\n${marker}\n`)
  if (at !== -1) return at + 2
  return text.startsWith(`${marker}\n`) ? 0 : -1
}

/**
 * Lift a block off the end of message text. The app writes each block last, so
 * a marker with anything but entries after it (one quoted in a comment, say) is
 * part of the message.
 */
function parseTrailingBlock<T>(text: string, marker: string, entry: (line: string) => T | null): { cleanText: string; entries: T[] } {
  const none = { cleanText: text, entries: [] }
  const start = blockStart(text, marker)
  if (start === -1) return none
  const entries: T[] = []
  for (const line of text.slice(start + marker.length + 1).split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const parsed = entry(trimmed)
    if (parsed === null) return none
    entries.push(parsed)
  }
  return entries.length > 0 ? { cleanText: text.slice(0, start).trimEnd(), entries } : none
}

/**
 * Parse an "[Attached files:]" section from message text.
 * Returns the message text without the attached files block, and the list of file paths.
 */
export function parseAttachedFiles(text: string): { cleanText: string; attachedFiles: string[] } {
  const { cleanText, entries } = parseTrailingBlock(text, MARKER, (line) => line.match(/^-\s+(.+)$/)?.[1] ?? null)
  return { cleanText, attachedFiles: entries }
}

/**
 * Append a mounted folders block to a message.
 */
export function appendMountedFolders(
  message: string,
  mounts: { containerPath: string; hostPath: string }[]
): string {
  if (mounts.length === 0) return message
  const block = `${MOUNT_MARKER}\n${mounts.map((m) => `- ${m.containerPath} (from ${m.hostPath})`).join('\n')}`
  return message ? `${message}\n\n${block}` : block
}

/**
 * Parse an "[Attached drives (read-write):]" section from message text.
 */
export function parseMountedFolders(text: string): {
  cleanText: string
  mountedFolders: { containerPath: string; hostPath: string }[]
} {
  const current = parseTrailingBlock(text, MOUNT_MARKER, mountEntry)
  const { cleanText, entries } = current.entries.length > 0 ? current : parseTrailingBlock(text, OLD_MOUNT_MARKER, mountEntry)
  return { cleanText, mountedFolders: entries }
}

function mountEntry(line: string): { containerPath: string; hostPath: string } | null {
  const match = line.match(/^-\s+(\S+)\s+\(from\s+(.+)\)$/)
  return match ? { containerPath: match[1], hostPath: match[2] } : null
}
