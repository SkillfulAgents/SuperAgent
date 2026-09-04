import { parseAttachedFiles, parseMountedFolders } from './attached-files'
import { parseSenderPrefix } from './sender-prefix'

export interface UserMessageParts {
  /** Sender lifted from a read-only chat mirror's escaped "\[sender]: " prefix. */
  sender: string | null
  attachedFiles: string[]
  mountedFolders: { containerPath: string; hostPath: string }[]
  /** The message text with every structured block above removed. */
  text: string
}

/**
 * Peel the structured blocks the app appends to a user message out of its
 * text: the connector sender prefix (read-only mirrors only, so a live user's
 * own "\[x]: " stays literal), then the attached-files block, then the
 * mounted-folders block. Both the bubble and the notification summary render
 * the leftover text.
 */
export function parseUserMessageParts(rawText: string, opts: { readOnly: boolean }): UserMessageParts {
  const { sender, cleanText: afterSender } = opts.readOnly
    ? parseSenderPrefix(rawText)
    : { sender: null, cleanText: rawText }
  const { cleanText: afterFiles, attachedFiles } = parseAttachedFiles(afterSender)
  const { cleanText: text, mountedFolders } = parseMountedFolders(afterFiles)
  return { sender, attachedFiles, mountedFolders, text }
}
