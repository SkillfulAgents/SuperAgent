/**
 * Optimistic local copy of a user message that has been POSTed to the server
 * but not yet observed in the persisted transcript.
 *
 * `uuid` is generated client-side and travels with the message through the
 * host API and container into the session JSONL, so the optimistic copy is
 * removed by exact id match once the message shows up in fetched messages —
 * no text/timestamp heuristics.
 */
export interface PendingMessage {
  uuid: string
  text: string
  sentAt: number
  /**
   * Sent while the agent was mid-turn. The message is buffered by the agent
   * loop (SDK streaming input) and rendered as a "queued" ghost until the
   * agent picks it up and it materializes in the transcript.
   */
  queued?: boolean
  sender?: { id: string; name: string; email: string }
}
