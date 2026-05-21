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
import { eq, desc, and, lt, inArray } from 'drizzle-orm'
import { count } from 'drizzle-orm'

// Re-export types for external use
export type { Notification, NewNotification }

export type NotificationType = 'session_complete' | 'session_waiting' | 'session_scheduled' | 'session_webhook' | 'session_chat_integration'

// ============================================================================
// Types
// ============================================================================

export interface CreateNotificationParams {
  type: NotificationType
  sessionId: string
  agentSlug: string
  title: string
  body: string
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
      .where(inArray(notifications.agentSlug, slugs))
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
      .where(inArray(notifications.agentSlug, slugs))
    return result[0]?.count ?? 0
  }
  const result = await db
    .select({ count: count() })
    .from(notifications)
  return result[0]?.count ?? 0
}

/**
 * Notification types that drive any unread dot or count in the UI.
 * Lifecycle events (`session_scheduled`, `session_chat_integration`,
 * `session_webhook`) live in the popover history but do not contribute
 * to badges — the user didn't take an action that requires their attention.
 */
export const USER_ACTIONABLE_NOTIFICATION_TYPES = ['session_complete', 'session_waiting'] as const

/**
 * Get session IDs that have unread notifications for a given agent.
 * Useful for showing "unseen" indicators in the sidebar.
 */
export async function getSessionIdsWithUnreadNotifications(agentSlug: string, userId?: string): Promise<Set<string>> {
  const conditions = [
    eq(notifications.agentSlug, agentSlug),
    eq(notifications.isRead, false),
    inArray(notifications.type, [...USER_ACTIONABLE_NOTIFICATION_TYPES]),
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
export async function getUnreadNotificationsByAgents(agentSlugs: string[]): Promise<Map<string, Set<string>>> {
  if (agentSlugs.length === 0) return new Map()

  const rows = await db
    .select({ agentSlug: notifications.agentSlug, sessionId: notifications.sessionId })
    .from(notifications)
    .where(and(
      inArray(notifications.agentSlug, agentSlugs),
      eq(notifications.isRead, false),
      inArray(notifications.type, [...USER_ACTIONABLE_NOTIFICATION_TYPES]),
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
      .where(and(eq(notifications.isRead, false), inArray(notifications.agentSlug, slugs)))
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
      .where(and(eq(notifications.isRead, false), inArray(notifications.agentSlug, slugs), actionable))
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
      .where(and(eq(notifications.isRead, false), inArray(notifications.agentSlug, slugs)))
    return result.changes ?? 0
  }

  const result = await db
    .update(notifications)
    .set({
      isRead: true,
      readAt: new Date(),
    })
    .where(eq(notifications.isRead, false))

  return result.changes ?? 0
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

  return (result.changes ?? 0) > 0
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
