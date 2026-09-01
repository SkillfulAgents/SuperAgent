/**
 * Notification Service
 *
 * Database operations for user notifications.
 * Handles creating, listing, and marking notifications as read.
 *
 * In auth mode, list/count/mark-read queries are scoped to the user's
 * accessible agents (via agentAcl). Pass userId to scope; omit for all.
 */

import { db } from '@shared/lib/db'
import { notifications, agentAcl, type Notification, type NewNotification } from '@shared/lib/db/schema'
import { eq, desc, and, lt, inArray, or, isNull, asc } from 'drizzle-orm'
import { count } from 'drizzle-orm'
import { USER_ACTIONABLE_NOTIFICATION_TYPES } from '@shared/lib/notifications/notification-preferences'

// Re-export types for external use
export type { Notification, NewNotification }

export type NotificationType =
  | 'session_complete' | 'session_waiting' | 'session_scheduled'
  | 'session_webhook' | 'session_chat_integration' | 'session_mention'

// ============================================================================
// Types
// ============================================================================

export interface CreateNotificationParams {
  type: NotificationType
  sessionId: string
  agentSlug: string
  title: string
  body: string
  recipientUserId?: string
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

/** Get the users who can receive notifications for an agent in auth mode. */
export async function getAgentAccessUserIds(agentSlug: string): Promise<string[]> {
  const rows = await db
    .select({ userId: agentAcl.userId })
    .from(agentAcl)
    .where(eq(agentAcl.agentSlug, agentSlug))
  return rows.map((row) => row.userId)
}

// A row with a recipient is visible only to that recipient. Rows without one
// behave as before. Local mode (no userId) sees agent-scoped rows only.
function recipientScope(userId?: string) {
  return userId
    ? or(isNull(notifications.recipientUserId), eq(notifications.recipientUserId, userId))
    : isNull(notifications.recipientUserId)
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
    recipientUserId: params.recipientUserId,
    messageUuid: params.messageUuid,
    isRead: false,
    createdAt: new Date(),
  }

  await db.insert(notifications).values(newNotification)

  return id
}

export async function createNotificationsBatch(rows: CreateNotificationParams[]): Promise<string[]> {
  return db.transaction((tx) => {
    const ids: string[] = []
    for (const row of rows) {
      const id = crypto.randomUUID()
      tx.insert(notifications).values({
        id,
        type: row.type,
        sessionId: row.sessionId,
        agentSlug: row.agentSlug,
        title: row.title,
        body: row.body,
        recipientUserId: row.recipientUserId,
        messageUuid: row.messageUuid,
        isRead: false,
        createdAt: new Date(),
      }).run()
      ids.push(id)
    }
    return ids
  })
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
      .where(and(inArray(notifications.agentSlug, slugs), recipientScope(userId)))
      .orderBy(desc(notifications.createdAt))
      .limit(limit)
      .offset(offset)
  }
  return db
    .select()
    .from(notifications)
    .where(recipientScope())
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
      .where(and(inArray(notifications.agentSlug, slugs), recipientScope(userId)))
    return result[0]?.count ?? 0
  }
  const result = await db
    .select({ count: count() })
    .from(notifications)
    .where(recipientScope())
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
 * Useful for showing "unseen" indicators in the sidebar.
 * Caller already authorized this agent. Do not re-check ACL membership
 * here: org admins can read an agent without an ACL row.
 */
export async function getSessionIdsWithUnreadNotifications(agentSlug: string, userId?: string): Promise<Set<string>> {
  const conditions = [
    eq(notifications.agentSlug, agentSlug),
    eq(notifications.isRead, false),
    inArray(notifications.type, [...USER_ACTIONABLE_NOTIFICATION_TYPES]),
    recipientScope(userId),
  ]

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
export async function getUnreadNotificationsByAgents(agentSlugs: string[], userId?: string): Promise<Map<string, Set<string>>> {
  if (agentSlugs.length === 0) return new Map()

  const rows = await db
    .select({ agentSlug: notifications.agentSlug, sessionId: notifications.sessionId })
    .from(notifications)
    .where(and(
      inArray(notifications.agentSlug, agentSlugs),
      eq(notifications.isRead, false),
      inArray(notifications.type, [...USER_ACTIONABLE_NOTIFICATION_TYPES]),
      recipientScope(userId),
    ))

  const result = new Map<string, Set<string>>()
  for (const row of rows) {
    let set = result.get(row.agentSlug)
    if (!set) { set = new Set(); result.set(row.agentSlug, set) }
    set.add(row.sessionId)
  }
  return result
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
      .where(and(eq(notifications.isRead, false), inArray(notifications.agentSlug, slugs), recipientScope(userId)))
      .orderBy(desc(notifications.createdAt))
      .limit(limit)
  }
  return db
    .select()
    .from(notifications)
    .where(and(eq(notifications.isRead, false), recipientScope()))
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
      .where(and(eq(notifications.isRead, false), inArray(notifications.agentSlug, slugs), actionable, recipientScope(userId)))
    return result[0]?.count ?? 0
  }
  const result = await db
    .select({ count: count() })
    .from(notifications)
    .where(and(eq(notifications.isRead, false), actionable, recipientScope()))

  return result[0]?.count ?? 0
}

/** Unread session_mention rows visible to this user. */
export async function getUnreadMentionCount(userId?: string): Promise<number> {
  if (!userId) return 0
  const slugs = await getAccessibleAgentSlugs(userId)
  if (slugs.length === 0) return 0
  const result = await db
    .select({ count: count() })
    .from(notifications)
    .where(and(
      eq(notifications.isRead, false),
      eq(notifications.type, 'session_mention'),
      inArray(notifications.agentSlug, slugs),
      recipientScope(userId),
    ))
  return result[0]?.count ?? 0
}

/** Agent slug → session ids with an unread mention for this user. */
export async function getSessionIdsWithUnreadMentionsByAgents(
  agentSlugs: string[],
  userId: string,
): Promise<Map<string, Set<string>>> {
  if (agentSlugs.length === 0) return new Map()
  const rows = await db
    .select({ agentSlug: notifications.agentSlug, sessionId: notifications.sessionId })
    .from(notifications)
    .where(and(
      inArray(notifications.agentSlug, agentSlugs),
      eq(notifications.isRead, false),
      eq(notifications.type, 'session_mention'),
      recipientScope(userId),
    ))
  const result = new Map<string, Set<string>>()
  for (const row of rows) {
    let set = result.get(row.agentSlug)
    if (!set) { set = new Set(); result.set(row.agentSlug, set) }
    set.add(row.sessionId)
  }
  return result
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
export async function markAsRead(notificationId: string, userId?: string): Promise<boolean> {
  const result = await db
    .update(notifications)
    .set({
      isRead: true,
      readAt: new Date(),
    })
    .where(and(eq(notifications.id, notificationId), recipientScope(userId)))

  return (result.changes ?? 0) > 0
}

/**
 * Mark all notifications for a session as read.
 * When userId is provided, only marks notifications for agents the user has access to.
 */
export async function markSessionNotificationsRead(sessionId: string, userId?: string): Promise<number> {
  const conditions = [
    eq(notifications.sessionId, sessionId),
    eq(notifications.isRead, false),
    recipientScope(userId),
  ]

  if (userId) {
    const slugs = await getAccessibleAgentSlugs(userId)
    if (slugs.length === 0) return 0
    conditions.push(inArray(notifications.agentSlug, slugs))
  }

  const result = await db
    .update(notifications)
    .set({
      isRead: true,
      readAt: new Date(),
    })
    .where(and(...conditions))

  return result.changes ?? 0
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
      .where(and(eq(notifications.isRead, false), inArray(notifications.agentSlug, slugs), recipientScope(userId)))
    return result.changes ?? 0
  }

  const result = await db
    .update(notifications)
    .set({
      isRead: true,
      readAt: new Date(),
    })
    .where(and(eq(notifications.isRead, false), recipientScope()))

  return result.changes ?? 0
}

// ============================================================================
// Delete Operations
// ============================================================================

/**
 * Delete a notification
 */
export async function deleteNotification(notificationId: string, userId?: string): Promise<boolean> {
  const result = await db
    .delete(notifications)
    .where(and(eq(notifications.id, notificationId), recipientScope(userId)))

  return (result.changes ?? 0) > 0
}

/** sessionId → oldest unread mention messageUuid for this user, for the jump target. */
export async function getOldestUnreadMentionBySession(agentSlug: string, userId: string): Promise<Map<string, string>> {
  const rows = await db
    .select({ sessionId: notifications.sessionId, messageUuid: notifications.messageUuid })
    .from(notifications)
    .where(and(
      eq(notifications.agentSlug, agentSlug),
      eq(notifications.type, 'session_mention'),
      eq(notifications.isRead, false),
      eq(notifications.recipientUserId, userId),
    ))
    .orderBy(asc(notifications.createdAt))
  const out = new Map<string, string>()
  for (const r of rows) if (r.messageUuid && !out.has(r.sessionId)) out.set(r.sessionId, r.messageUuid)
  return out
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

  return result.changes ?? 0
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

  return result.changes ?? 0
}
