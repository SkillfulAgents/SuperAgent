/**
 * Optimistic local copy of a user message that has been POSTed to the server
 * but not yet observed in the persisted transcript.
 *
 * `localId` is a client-side correlation id: it is the stable render key and
 * the handle used to update/remove the entry. `uuid` is the server-assigned
 * message id (returned by the POST response); the server generates it (never
 * the client — it keys the messageAuthor attribution row) and forwards it to
 * the container where it becomes the JSONL entry id, so the optimistic copy
 * is materialized by exact id match once the message shows up in fetched
 * messages. Mid-turn (queued) messages keep that id as their queued_command
 * source_uuid, so they match the same way.
 */
export interface PendingMessage {
  localId: string
  /** Server-assigned message uuid; set when the POST response arrives. */
  uuid?: string
  text: string
  sentAt: number
  /**
   * Sent while the agent was mid-turn. The message is buffered by the agent
   * loop (SDK streaming input) and rendered as a "queued" ghost until the
   * agent picks it up and it materializes in the transcript.
   */
  queued?: boolean
  /** The newest transcript entry the client held at send; unset when it held none (empty, or not loaded yet). */
  afterMessageId?: string
  sender?: { id: string; name: string; email: string }
}

/** True for user messages that start a new turn — queued (mid-turn) messages don't end the turn they appear in. */
export function isTurnStartingUserMessage(m: { type: string; queued?: boolean }): boolean {
  return m.type === 'user' && !m.queued
}

/**
 * True while a pending message sent from idle starts a new turn. Once a
 * turn-starting user message sits after the entry it was sent after, the
 * pending message is stranded and must not close every later turn. Only such a
 * message counts: the previous turn's final answer, or a queued message, can
 * land after a quick follow-up's anchor. No anchor, or one no longer loaded
 * (paged out behind later messages, or deleted), counts every loaded message
 * as later.
 */
export function isTurnStartingPendingMessage(
  pending: PendingMessage,
  messages: ReadonlyArray<{ id: string; type: string; queued?: boolean }>
): boolean {
  if (pending.queued) return false
  const later = messages.slice(messages.findIndex((m) => m.id === pending.afterMessageId) + 1)
  return !later.some(isTurnStartingUserMessage)
}
