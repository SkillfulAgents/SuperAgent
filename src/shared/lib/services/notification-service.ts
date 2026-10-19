/**
 * Notification Service
 *
 * Database operations for user notifications.
 * Handles creating, listing, and marking notifications as read.
 *
 * In auth mode, list/count/mark-read queries are scoped to the user's
 * accessible agents (via agentAcl). Pass userId to scope; omit for all.
 * A targeted row (a mention) is seen only by its recipient: every read for a
 * user applies visibleTo().
 */

import { db } from '@shared/lib/db'
import { changesOf } from '@shared/lib/db/batch'
import { notifications, agentAcl, type Notification, type NewNotification } from '@shared/lib/db/schema'
import { eq, desc, and, lt, inArray, isNull, or } from 'drizzle-orm'
import { count } from 'drizzle-orm'
import { USER_ACTIONABLE_NOTIFICATION_TYPES } from '@shared/lib/notifications/notification-preferences'

// Re-export types for external use
export type { Notification, NewNotification }

export type NotificationType = 'session_complete' | 'session_waiting' | 'session_scheduled' | 'session_webhook' | 'session_chat_integration' | 'session_mention'

// ============================================================================
// Types
// ============================================================================

export interface CreateNotificationParams {
  type: NotificationType
  sessionId: string
  agentSlug: string
  title: string
  body: string
  /** A targeted row: only this user sees it, and its read state is theirs. */
  recipientUserId?: string
  /** The transcript message a targeted row points at. */
  messageUuid?: string
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Get all agent slugs accessible to a user (via agentAcl entries).
 */
export async function getAccessibleAgentSlugs(userId: string): Promise<string[]> {
  const rows = await db
    .select({ agentSlug: agentAcl.agentSlug })
    .from(agentAcl)
    .where(eq(agentAcl.userId, userId))
  return rows.map((r) => r.agentSlug)
}

/**
 * The rows a user may see: every shared row, and the targeted rows addressed
 * to them. Without a viewer (local mode) nothing is hidden.
 */
function visibleTo(viewerId: string | undefined) {
  if (viewerId === undefined) return undefined
  return or(isNull(notifications.recipientUserId), eq(notifications.recipientUserId, viewerId))
}

/** Get the users who can receive notifications for an agent in auth mode. */
export async function getAgentAccessUserIds(agentSlug: string): Promise<string[]> {
  const rows = await db
    .select({ userId: agentAcl.userId })
    .from(agentAcl)
    .where(eq(agentAcl.agentSlug, agentSlug))
  return rows.map((row) => row.userId)
}

// ============================================================================
// Create Operations
// ============================================================================

/**
 * Create a new notification
 */
export async function createNotification(
  params: CreateNotificationParams
): Promise<string> {
  const id = crypto.randomUUID()

  const newNotification: NewNotification = {
    id,
    type: params.type,
    sessionId: params.sessionId,
    agentSlug: params.agentSlug,
    title: params.title,
    body: params.body,
    isRead: false,
    recipientUserId: params.recipientUserId ?? null,
    messageUuid: params.messageUuid ?? null,
    createdAt: new Date(),
  }

  await db.insert(notifications).values(newNotification)

  return id
}

// ============================================================================
// Read Operations
// ============================================================================

/**
 * List notifications, ordered by creation time (newest first).
 * When userId is provided, only returns notifications for agents the user has access to.
 */
export async function listNotifications(limit: number = 50, userId?: string, offset: number = 0): Promise<Notification[]> {
  if (userId) {
    const slugs = await getAccessibleAgentSlugs(userId)
    if (slugs.length === 0) return []
    return db
      .select()
      .from(notifications)
      .where(and(inArray(notifications.agentSlug, slugs), visibleTo(userId)))
      .orderBy(desc(notifications.createdAt))
      .limit(limit)
      .offset(offset)
  }
  return db
    .select()
    .from(notifications)
    .orderBy(desc(notifications.createdAt))
    .limit(limit)
    .offset(offset)
}

export async function countNotifications(userId?: string): Promise<number> {
  if (userId) {
    const slugs = await getAccessibleAgentSlugs(userId)
    if (slugs.length === 0) return 0
    const result = await db
      .select({ count: count() })
      .from(notifications)
      .where(and(inArray(notifications.agentSlug, slugs), visibleTo(userId)))
    return result[0]?.count ?? 0
  }
  const result = await db
    .select({ count: count() })
    .from(notifications)
  return result[0]?.count ?? 0
}

/**
 * Notification types that drive any unread dot or count in the UI.
 * Definition lives in the renderer-safe notification-preferences leaf (this
 * module imports the DB and cannot be pulled into the renderer); re-exported
 * here for the existing server-side consumers.
 */
export { USER_ACTIONABLE_NOTIFICATION_TYPES }

/**
 * Get session IDs that have unread notifications for a given agent.
 * Useful for showing "unseen" indicators in the sidebar. `viewerId` hides
 * other people's mentions without the ACL check `userId` adds.
 */
export async function getSessionIdsWithUnreadNotifications(agentSlug: string, userId?: string, viewerId = userId): Promise<Set<string>> {
  const conditions = [
    eq(notifications.agentSlug, agentSlug),
    eq(notifications.isRead, false),
    inArray(notifications.type, [...USER_ACTIONABLE_NOTIFICATION_TYPES]),
    visibleTo(viewerId),
  ]

  if (userId) {
    const slugs = await getAccessibleAgentSlugs(userId)
    if (!slugs.includes(agentSlug)) return new Set()
  }

  const rows = await db
    .select({ sessionId: notifications.sessionId })
    .from(notifications)
    .where(and(...conditions))

  return new Set(rows.map(r => r.sessionId))
}

/**
 * Batch version: get unread notification session IDs for multiple agents in a single query.
 * Returns a Map from agentSlug to Set of sessionIds with unread notifications.
 */
export async function getUnreadNotificationsByAgents(agentSlugs: string[], viewerId?: string): Promise<Map<string, Set<string>>> {
  if (agentSlugs.length === 0) return new Map()

  const rows = await db
    .select({ agentSlug: notifications.agentSlug, sessionId: notifications.sessionId })
    .from(notifications)
    .where(and(
      inArray(notifications.agentSlug, agentSlugs),
      eq(notifications.isRead, false),
      inArray(notifications.type, [...USER_ACTIONABLE_NOTIFICATION_TYPES]),
      visibleTo(viewerId),
    ))

  const result = new Map<string, Set<string>>()
  for (const row of rows) {
    let set = result.get(row.agentSlug)
    if (!set) { set = new Set(); result.set(row.agentSlug, set) }
    set.add(row.sessionId)
  }
  return result
}

/** A viewer's own unread mentions: the rows that draw an @ instead of a dot. */
function unreadMentionsOf(viewerId: string) {
  return and(
    eq(notifications.recipientUserId, viewerId),
    eq(notifications.type, 'session_mention'),
    eq(notifications.isRead, false),
  )
}

/** Sessions of an agent where the viewer was mentioned and has not looked yet. */
export async function getSessionIdsWithUnreadMentions(agentSlug: string, viewerId: string): Promise<Set<string>> {
  const rows = await db
    .select({ sessionId: notifications.sessionId })
    .from(notifications)
    .where(and(eq(notifications.agentSlug, agentSlug), unreadMentionsOf(viewerId)))
  return new Set(rows.map((row) => row.sessionId))
}

/** Batch version of getSessionIdsWithUnreadMentions, one query for many agents. */
export async function getUnreadMentionsByAgents(agentSlugs: string[], viewerId: string): Promise<Map<string, Set<string>>> {
  if (agentSlugs.length === 0) return new Map()
  const rows = await db
    .select({ agentSlug: notifications.agentSlug, sessionId: notifications.sessionId })
    .from(notifications)
    .where(and(inArray(notifications.agentSlug, agentSlugs), unreadMentionsOf(viewerId)))
  const result = new Map<string, Set<string>>()
  for (const row of rows) {
    let set = result.get(row.agentSlug)
    if (!set) { set = new Set(); result.set(row.agentSlug, set) }
    set.add(row.sessionId)
  }
  return result
}

/**
 * The viewer's unread mentions, on agents they can still open (a lost share
 * hides them like any other row).
 */
export async function getUnreadMentionCount(userId: string): Promise<number> {
  const slugs = await getAccessibleAgentSlugs(userId)
  if (slugs.length === 0) return 0
  const result = await db
    .select({ count: count() })
    .from(notifications)
    .where(and(inArray(notifications.agentSlug, slugs), unreadMentionsOf(userId)))
  return result[0]?.count ?? 0
}

/**
 * List unread notifications.
 * When userId is provided, only returns notifications for agents the user has access to.
 */
export async function listUnreadNotifications(limit: number = 50, userId?: string): Promise<Notification[]> {
  if (userId) {
    const slugs = await getAccessibleAgentSlugs(userId)
    if (slugs.length === 0) return []
    return db
      .select()
      .from(notifications)
      .where(and(eq(notifications.isRead, false), inArray(notifications.agentSlug, slugs), visibleTo(userId)))
      .orderBy(desc(notifications.createdAt))
      .limit(limit)
  }
  return db
    .select()
    .from(notifications)
    .where(eq(notifications.isRead, false))
    .orderBy(desc(notifications.createdAt))
    .limit(limit)
}

/**
 * Get unread notification count.
 * When userId is provided, only counts notifications for agents the user has access to.
 */
export async function getUnreadCount(userId?: string): Promise<number> {
  const actionable = inArray(notifications.type, [...USER_ACTIONABLE_NOTIFICATION_TYPES])
  if (userId) {
    const slugs = await getAccessibleAgentSlugs(userId)
    if (slugs.length === 0) return 0
    const result = await db
      .select({ count: count() })
      .from(notifications)
      .where(and(eq(notifications.isRead, false), inArray(notifications.agentSlug, slugs), actionable, visibleTo(userId)))
    return result[0]?.count ?? 0
  }
  const result = await db
    .select({ count: count() })
    .from(notifications)
    .where(and(eq(notifications.isRead, false), actionable))

  return result[0]?.count ?? 0
}

/**
 * Get a single notification by ID
 */
export async function getNotification(notificationId: string): Promise<Notification | null> {
  const results = await db
    .select()
    .from(notifications)
    .where(eq(notifications.id, notificationId))

  return results[0] || null
}

// ============================================================================
// Update Operations
// ============================================================================

/**
 * Mark a notification as read
 */
export async function markAsRead(notificationId: string): Promise<boolean> {
  const result = await db
    .update(notifications)
    .set({
      isRead: true,
      readAt: new Date(),
    })
    .where(eq(notifications.id, notificationId))

  return changesOf(result) > 0
}

/**
 * Mark all notifications for a session as read.
 * When userId is provided, only marks notifications for agents the user has access to.
 */
export async function markSessionNotificationsRead(sessionId: string, userId?: string): Promise<number> {
  const conditions = [
    eq(notifications.sessionId, sessionId),
    eq(notifications.isRead, false),
  ]

  if (userId) {
    const slugs = await getAccessibleAgentSlugs(userId)
    if (slugs.length === 0) return 0
    conditions.push(inArray(notifications.agentSlug, slugs), visibleTo(userId)!)
  }

  const result = await db
    .update(notifications)
    .set({
      isRead: true,
      readAt: new Date(),
    })
    .where(and(...conditions))

  return changesOf(result)
}

/**
 * Mark all notifications as read.
 * When userId is provided, only marks notifications for agents the user has access to.
 */
export async function markAllAsRead(userId?: string): Promise<number> {
  if (userId) {
    const slugs = await getAccessibleAgentSlugs(userId)
    if (slugs.length === 0) return 0
    const result = await db
      .update(notifications)
      .set({
        isRead: true,
        readAt: new Date(),
      })
      .where(and(eq(notifications.isRead, false), inArray(notifications.agentSlug, slugs), visibleTo(userId)))
    return changesOf(result)
  }

  const result = await db
    .update(notifications)
    .set({
      isRead: true,
      readAt: new Date(),
    })
    .where(eq(notifications.isRead, false))

  return changesOf(result)
}

// ============================================================================
// Delete Operations
// ============================================================================

/**
 * Delete a notification
 */
export async function deleteNotification(notificationId: string): Promise<boolean> {
  const result = await db
    .delete(notifications)
    .where(eq(notifications.id, notificationId))

  return changesOf(result) > 0
}

/**
 * Delete all notifications for the given session IDs.
 *
 * Used by session retention cleanup (SessionAutoDeleteMonitor) and manual
 * session deletion so that notification history does not retain rows pointing
 * at sessions that no longer exist. Notifications are stored in BOTH auth and
 * non-auth modes (userId is nullable), so callers should invoke this
 * unconditionally — not gated on auth mode.
 *
 * No-op (returns 0) when the input list is empty.
 */
export async function deleteNotificationsBySessionIds(sessionIds: string[]): Promise<number> {
  if (sessionIds.length === 0) return 0

  const result = await db
    .delete(notifications)
    .where(inArray(notifications.sessionId, sessionIds))

  return changesOf(result)
}

/**
 * Delete old notifications (older than specified days)
 */
export async function deleteOldNotifications(olderThanDays: number = 30): Promise<number> {
  const cutoffDate = new Date()
  cutoffDate.setDate(cutoffDate.getDate() - olderThanDays)

  const result = await db
    .delete(notifications)
    .where(lt(notifications.createdAt, cutoffDate))

  return changesOf(result)
}
