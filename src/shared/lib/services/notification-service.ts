/**
 * Notification Service
 *
 * Database operations for user notifications.
 * Handles creating, listing, and marking notifications as read.
 */

import { db } from '@shared/lib/db'
import { notifications, type Notification, type NewNotification } from '@shared/lib/db/schema'
import { eq, desc, and, lt } from 'drizzle-orm'
import { count } from 'drizzle-orm'

// Re-export types for external use
export type { Notification, NewNotification }

export type NotificationType = 'session_complete' | 'session_waiting' | 'session_scheduled'

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
 * List notifications, ordered by creation time (newest first)
 */
export async function listNotifications(limit: number = 50): Promise<Notification[]> {
  return db
    .select()
    .from(notifications)
    .orderBy(desc(notifications.createdAt))
    .limit(limit)
}

/**
 * List unread notifications
 */
export async function listUnreadNotifications(limit: number = 50): Promise<Notification[]> {
  return db
    .select()
    .from(notifications)
    .where(eq(notifications.isRead, false))
    .orderBy(desc(notifications.createdAt))
    .limit(limit)
}

/**
 * Get unread notification count
 */
export async function getUnreadCount(): Promise<number> {
  const result = await db
    .select({ count: count() })
    .from(notifications)
    .where(eq(notifications.isRead, false))

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
 * Mark all notifications for a session as read
 */
export async function markSessionNotificationsRead(sessionId: string): Promise<number> {
  const result = await db
    .update(notifications)
    .set({
      isRead: true,
      readAt: new Date(),
    })
    .where(
      and(
        eq(notifications.sessionId, sessionId),
        eq(notifications.isRead, false)
      )
    )

  return result.changes ?? 0
}

/**
 * Mark all notifications as read
 */
export async function markAllAsRead(): Promise<number> {
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
