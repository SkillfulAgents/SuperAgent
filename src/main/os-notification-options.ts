import type { NotificationConstructorOptions } from 'electron'

/** What the renderer and the notification stream attach to an OS notification. */
interface OsNotificationContext {
  agentSlug?: string
  kind?: string
  reviewId?: string
}

// Windows rejects a toast whose Tag or Group is longer than this.
const WINDOWS_TOAST_KEY_MAX = 64

/** The proxy review an OS notification asks about, if it is one. */
export function reviewIdOf(context: unknown): string | undefined {
  const ctx = context as OsNotificationContext | undefined
  return ctx?.kind === 'proxy_review' && typeof ctx.reviewId === 'string' ? ctx.reviewId : undefined
}

/** The notification id a review's OS notification is posted under (macOS). */
export function reviewNotificationId(reviewId: string): string {
  return `review:${reviewId}`
}

/**
 * Options for an OS notification, shared by the renderer's IPC path and the
 * closed-window fallback so both post the same thing.
 */
export function osNotificationOptions(
  { title, body, actions, context }: { title: string; body: string; actions?: Array<{ text: string }>; context?: unknown },
  platform: NodeJS.Platform = process.platform,
): NotificationConstructorOptions {
  const agentSlug = (context as OsNotificationContext | undefined)?.agentSlug
  const reviewId = reviewIdOf(context)
  return {
    title,
    body,
    ...(actions && actions.length > 0
      ? { actions: actions.map((a) => ({ type: 'button' as const, text: a.text })) }
      : {}),
    // One Notification Center thread (macOS) / toast group (Windows) per agent.
    ...(typeof agentSlug === 'string' && agentSlug
      ? { groupId: agentSlug.slice(0, WINDOWS_TOAST_KEY_MAX) }
      : {}),
    // On macOS a review's notification can then be removed by id when the review
    // resolves, whether or not this process still holds the Notification object.
    ...(reviewId && platform === 'darwin' ? { id: reviewNotificationId(reviewId) } : {}),
  }
}
