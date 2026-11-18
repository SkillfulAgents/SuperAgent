/**
 * What a person asked for in a user transcript entry: its text as the
 * transcript bubble shows it, or null for an entry no person wrote (a tool
 * result, a task notification, a compaction summary, a system notice, a
 * command's output). Shared by the session-complete summary and the actor's
 * transcript query (`{ kind: 'user-request' }`).
 */
import type { ContentBlock, JsonlMessageEntry, JsonlSystemEntry } from '@shared/lib/types/agent'
import { isTaskNotificationMessage, isToolResultOnlyMessage, parseCommandMessage } from './message-transform'
import { isSystemMessageText } from './system-message'
import { parseUserMessageParts } from './user-message-parts'

export function userRequestText(
  entry: JsonlMessageEntry | JsonlSystemEntry,
): string | null {
  if (
    entry.type !== 'user' ||
    entry.isCompactSummary ||
    isToolResultOnlyMessage(entry) ||
    isTaskNotificationMessage(entry)
  ) {
    return null
  }

  const content = entry.message.content
  let text = ''
  if (typeof content === 'string') {
    text = content
  } else if (Array.isArray(content)) {
    text = (content as ContentBlock[])
      .filter((block): block is ContentBlock & { type: 'text'; text: string } =>
        block.type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string',
      )
      .map((block) => block.text)
      .join('')
  }

  if (!text.trim() || isSystemMessageText(text)) {
    return null
  }

  const command = parseCommandMessage(text)
  if (command?.type === 'command-output') return null
  if (command?.type === 'slash-command') {
    text = command.args ? `/${command.name} ${command.args}` : `/${command.name}`
  }

  // Same peel as the transcript bubble.
  text = parseUserMessageParts(text).text
  return text.trim() || null
}
