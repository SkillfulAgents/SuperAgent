import { parseAttachedFiles, parseMountedFolders } from './attached-files'
import { parseComputerUseNote } from './computer-use-note'
import { parseDashboardCommentContext } from './dashboard-comment'
import { parseDictationNote } from './dictation-note'
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
  /** What a dashboard comment told the agent beside the comment itself, folded in the bubble. */
  dashboardContext: string | null
  /** The message text with every structured block above removed. */
  text: string
}

/**
 * Peel the structured blocks the app appends to a user message out of its
 * text: the sender prefix, then the computer-use and dictation notes (which
 * are only for the agent), then the mentions block, then the attached-files
 * block, then the mounted-folders block, then a dashboard comment's context.
 * Both the bubble and the notification summary render the leftover text.
 */
export function parseUserMessageParts(rawText: string): UserMessageParts {
  const { sender, cleanText: afterSender } = parseSenderPrefix(rawText)
  const { cleanText: afterComputerUse } = parseComputerUseNote(afterSender)
  const { cleanText: afterNote } = parseDictationNote(afterComputerUse)
  const { cleanText: afterMentions, mentions, silent } = parseMentions(afterNote)
  const { cleanText: afterFiles, attachedFiles } = parseAttachedFiles(afterMentions)
  const { cleanText: afterFolders, mountedFolders } = parseMountedFolders(afterFiles)
  const { cleanText: text, context: dashboardContext } = parseDashboardCommentContext(afterFolders)
  return { sender, mentions, silent, attachedFiles, mountedFolders, dashboardContext, text }
}
