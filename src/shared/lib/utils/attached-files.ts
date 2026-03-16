const MARKER = '[Attached files:]'
const MOUNT_MARKER = '[Mounted folders (read-write):]'

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
 * Parse a "[Mounted folders (read-write):]" section from message text.
 */
export function parseMountedFolders(text: string): {
  cleanText: string
  mountedFolders: { containerPath: string; hostPath: string }[]
} {
  const markerIndex = text.indexOf(MOUNT_MARKER)
  if (markerIndex === -1) return { cleanText: text, mountedFolders: [] }

  const before = text.slice(0, markerIndex).trimEnd()
  const after = text.slice(markerIndex + MOUNT_MARKER.length)

  const mounts: { containerPath: string; hostPath: string }[] = []
  const lines = after.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const match = trimmed.match(/^-\s+(\S+)\s+\(from\s+(.+)\)$/)
    if (match) {
      mounts.push({ containerPath: match[1], hostPath: match[2] })
    } else {
      break
    }
  }

  return { cleanText: before, mountedFolders: mounts }
}
