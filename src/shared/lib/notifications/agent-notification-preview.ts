import type { UnreadNotificationPreview } from '../services/notification-service'
import type { SessionMetadataMap } from '../types/agent'
import { isHiddenAutomatedSession } from '../services/session-visibility'

/** Shared by the agents GET and read mutations, so priority/visibility cannot drift. */
export function agentNotificationPreview(
  previews: UnreadNotificationPreview[],
  unreadSessionIds: Set<string>,
  sessionMetadata: SessionMetadataMap,
  awaitingSessionIds: string[],
  hasSessionsAwaitingInput: boolean,
  hasUnreadMention: boolean,
  hasUnreadNotifications: boolean,
) {
  const awaiting = new Set(awaitingSessionIds)
  const visibleUnread = (sessionId: string) => unreadSessionIds.has(sessionId) && !isHiddenAutomatedSession(sessionMetadata[sessionId])
  const preview = hasSessionsAwaitingInput
    ? previews.find(p => p.type === 'session_waiting' && awaiting.has(p.sessionId))
    : hasUnreadMention
      ? previews.find(p => p.type === 'session_mention' && visibleUnread(p.sessionId))
      : hasUnreadNotifications
        ? previews.find(p => visibleUnread(p.sessionId))
        : undefined
  const text = preview?.text.replace(/\s+/g, ' ').trim()
  return text && preview ? {
    notificationPreview: text,
    notificationPreviewSource: { id: preview.id, sessionId: preview.sessionId },
  } : {}
}
