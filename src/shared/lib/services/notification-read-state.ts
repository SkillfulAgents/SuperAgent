import { and, eq, inArray, isNull, or } from 'drizzle-orm'
import pLimit from 'p-limit'
import { db } from '../db'
import { notifications } from '../db/schema'
import { agentRegistry } from '../agent-actor'
import { agentNotificationPreview } from '../notifications/agent-notification-preview'
import type { NotificationReadState, NotificationReadTarget } from '../notifications/read-state-schema'
import {
  getAccessibleAgentSlugs, getUnreadCount, getUnreadMentionCount,
  getUnreadNotificationsByAgents, getUnreadMentionsByAgents, getUnreadNotificationPreviewsByAgents,
} from './notification-service'
import { getSessionIdsMarkedUnreadByAgents } from './session-unread-service'
import { isHiddenAutomatedSession } from './session-visibility'

/** Resolve affected agents on the server; never trust a client's list of slugs. */
export async function notificationReadAgentSlugs(target: NotificationReadTarget, viewerId?: string): Promise<string[]> {
  const allowed = viewerId ? await getAccessibleAgentSlugs(viewerId) : undefined
  if (allowed?.length === 0) return []
  const rows = await db.selectDistinct({ slug: notifications.agentSlug }).from(notifications).where(and(
    target.kind === 'all' ? eq(notifications.isRead, false)
      : target.kind === 'session' ? eq(notifications.sessionId, target.sessionId)
        : eq(notifications.id, target.id),
    allowed ? inArray(notifications.agentSlug, allowed) : undefined,
    viewerId ? or(isNull(notifications.recipientUserId), eq(notifications.recipientUserId, viewerId)) : undefined,
  ))
  return rows.map(row => row.slug)
}

/** Return the new projection with the write, without another client GET. */
export async function notificationReadState(slugs: string[], viewerId?: string): Promise<NotificationReadState> {
  const [count, mentions, unread, mentioned, marked, previews] = await Promise.all([
    getUnreadCount(viewerId),
    viewerId ? getUnreadMentionCount(viewerId) : 0,
    getUnreadNotificationsByAgents(slugs, viewerId),
    viewerId ? getUnreadMentionsByAgents(slugs, viewerId) : new Map<string, Set<string>>(),
    getSessionIdsMarkedUnreadByAgents(slugs, viewerId ?? 'local'),
    getUnreadNotificationPreviewsByAgents(slugs, viewerId),
  ])
  const limit = pLimit(5)
  const agents = await Promise.all(slugs.map(slug => limit(async () => {
    const actor = agentRegistry.get(slug)
    const [summary, metadata, live] = await Promise.all([
      actor.sessions.summary(), actor.sessions.readMetadata(), actor.live(),
    ])
    const markedIds = marked.get(slug) ?? new Set<string>()
    const unreadIds = new Set([...(unread.get(slug) ?? []), ...markedIds])
    const mentionIds = mentioned.get(slug) ?? new Set<string>()
    const visible = summary.sessionIds.filter(id => !isHiddenAutomatedSession(metadata[id]))
    const hasUnreadNotifications = visible.some(id => unreadIds.has(id))
    const hasUnreadMention = visible.some(id => unreadIds.has(id) && mentionIds.has(id))
    return {
      slug, hasUnreadNotifications, hasUnreadMention,
      ...agentNotificationPreview(
        previews.get(slug) ?? [], unreadIds, metadata, live.awaitingSessionIds,
        live.awaitingSessionIds.length > 0 || live.pendingReviews.length > 0,
        hasUnreadMention, hasUnreadNotifications,
      ),
      markedUnreadSessionIds: visible.filter(id => markedIds.has(id)),
      unreadSessionIds: [...unreadIds],
      mentionedSessionIds: [...mentionIds],
    }
  })))
  return { count, mentions, agents }
}

/** The write has committed; a failed confirmation must not pretend it failed. */
export async function confirmNotificationRead(slugs: string[], viewerId?: string): Promise<NotificationReadState | undefined> {
  try {
    return await notificationReadState(slugs, viewerId)
  } catch (error) {
    console.error('Failed to confirm notification read state:', error)
    return undefined
  }
}
