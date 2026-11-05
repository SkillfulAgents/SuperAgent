import type { JsonlMessageEntry, JsonlSystemEntry } from '@shared/lib/types/agent'
import { isTaskNotificationMessage, isToolResultOnlyMessage } from '@shared/lib/utils/message-transform'

type TranscriptEntry = JsonlMessageEntry | JsonlSystemEntry

/**
 * A message someone sent: a user entry that is not a tool result, an SDK note
 * or a compaction summary. The next one ends the reply to the one before it.
 */
function isSentMessage(entry: TranscriptEntry): boolean {
  if (entry.type !== 'user') return false
  // SDK-written context lines carry isMeta; the type leaves it off user entries.
  if ((entry as { isMeta?: boolean }).isMeta || entry.isCompactSummary) return false
  return !isToolResultOnlyMessage(entry) && !isTaskNotificationMessage(entry)
}

/**
 * Where a fork "from this message" ends: the last transcript entry of the
 * agent's reply to it, so the fork holds the message and everything it led to,
 * up to the next message someone sent. The SDK's fork slices up to that uuid,
 * inclusive. Null when the message is not in the transcript.
 */
export function forkPointAfter(entries: readonly TranscriptEntry[], messageUuid: string): string | null {
  const start = entries.findIndex((entry) => entry.uuid === messageUuid)
  if (start === -1) return null
  let last = messageUuid
  for (const entry of entries.slice(start + 1)) {
    if (isSentMessage(entry)) break
    if (entry.uuid) last = entry.uuid
  }
  return last
}
