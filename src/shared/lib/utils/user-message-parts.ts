import { parseAttachedFiles, parseMountedFolders } from './attached-files'
import { parseMentions, type Mention } from './mentions'
import { parseSenderPrefix } from './sender-prefix'

export interface UserMessageParts {
  /** Sender lifted from an escaped "\[sender]: " attribution prefix. */
  sender: string | null
  /** The people and agents the message @-mentions, drawn as chips where their names stand. */
  mentions: Mention[]
  /** The message only notified the teammates it tags; the agent did not run. */
  silent: boolean
  attachedFiles: string[]
  mountedFolders: { containerPath: string; hostPath: string }[]
  /** The message text with every structured block above removed. */
  text: string
}

/**
 * Peel the structured blocks the app appends to a user message out of its
 * text: the sender prefix, then the mentions block, then the attached-files
 * block, then the mounted-folders block. Both the bubble and the notification
 * summary render the leftover text.
 */
export function parseUserMessageParts(rawText: string): UserMessageParts {
  const { sender, cleanText: afterSender } = parseSenderPrefix(rawText)
  const { cleanText: afterMentions, mentions, silent } = parseMentions(afterSender)
  const { cleanText: afterFiles, attachedFiles } = parseAttachedFiles(afterMentions)
  const { cleanText: text, mountedFolders } = parseMountedFolders(afterFiles)
  return { sender, mentions, silent, attachedFiles, mountedFolders, text }
}
