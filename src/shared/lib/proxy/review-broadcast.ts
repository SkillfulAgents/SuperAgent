import { messagePersister } from '@shared/lib/container/message-persister'

/**
 * Broadcast a review event globally so all UI clients (session views,
 * dashboards, sidebar) can react. Uses the global notification channel
 * instead of per-session SSE to avoid O(sessions) fan-out.
 *
 * The review payload is nested under `review` to avoid overwriting the
 * top-level `type` field that GlobalNotificationHandler switches on.
 */
export function broadcastReview(agentSlug: string, data: unknown): void {
  messagePersister.broadcastGlobal({
    type: 'session_awaiting_input',
    agentSlug,
    review: data,
  })
}
