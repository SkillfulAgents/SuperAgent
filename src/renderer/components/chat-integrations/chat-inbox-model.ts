import type { ChatIntegrationSession, ChatIntegrationAccess } from '@shared/lib/db/schema'

export type ChatAccessStatus = 'allowed' | 'pending' | 'denied'

/**
 * One row in the conversation inbox: a single external chat (person/group),
 * carrying both its access state (Telegram only) and its conversation windows.
 *
 * Access is per-chat; conversation windows are per-inactivity-period, so one chat
 * can own several windows (default timeout is Never → usually one). Pending and
 * denied chats have no windows at all - the agent never runs until allowed - so
 * `windows` is empty and only `firstMessagePreview` is shown.
 */
export interface ChatRow {
  externalChatId: string
  title: string
  /** Undefined when there's no access row (Slack/iMessage, or approval never on). */
  status?: ChatAccessStatus
  /** Present when this row came from an access entry (needed for approve/deny/revoke). */
  accessId?: string
  approvalSource?: ChatIntegrationAccess['approvalSource']
  firstMessagePreview?: string | null
  /** Conversation windows for this chat, newest-first. Empty for pending/denied. */
  windows: ChatIntegrationSession[]
  /** Newest window's claude session id, for opening the thread (null when none). */
  latestSessionId: string | null
  /** Sort key: newest window activity, else the access request (first-contact) time. */
  lastActivityAt: number
}

export const chatFallbackTitle = (externalChatId: string) => `Chat ${externalChatId.slice(-6)}`

/**
 * Merge conversation windows (sessions) and access entries into one chat-keyed
 * list. Active (allowed/ungated) conversations first by recency; blocked chats
 * (pending + denied - both show the "Blocked" tag) sink to the bottom.
 */
export function buildChatRows(
  sessions: ChatIntegrationSession[] | undefined,
  access: ChatIntegrationAccess[] | undefined,
): ChatRow[] {
  const byChat = new Map<string, ChatRow>()

  for (const a of access ?? []) {
    byChat.set(a.externalChatId, {
      externalChatId: a.externalChatId,
      title: a.title ?? chatFallbackTitle(a.externalChatId),
      status: a.status,
      accessId: a.id,
      approvalSource: a.approvalSource,
      firstMessagePreview: a.firstMessagePreview,
      windows: [],
      latestSessionId: null,
      // First-contact time, not the decision time: blocked chats have no windows,
      // so this is their sort key. Keying off requestedAt (never decidedAt) keeps a
      // fresh denial from jumping the queue above chats that are still waiting.
      lastActivityAt: new Date(a.requestedAt).getTime(),
    })
  }

  // Newest-first so windows[] and latestSessionId fall out of insertion order.
  const byRecency = [...(sessions ?? [])].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  )
  for (const s of byRecency) {
    let row = byChat.get(s.externalChatId)
    if (!row) {
      row = {
        externalChatId: s.externalChatId,
        // No access row (Slack/iMessage): the chat is named from its windows just below.
        title: chatFallbackTitle(s.externalChatId),
        windows: [],
        latestSessionId: null,
        lastActivityAt: 0,
      }
      byChat.set(s.externalChatId, row)
    }
    // Name a no-access chat from its newest NAMED window: byRecency is newest-first, so
    // the first window with a display name wins (a later window's stale name never
    // overwrites it), and an unnamed newest window falls through to the next one. Access
    // rows are created earlier and keep their canonical title, so they're skipped here.
    if (!row.accessId && s.displayName && row.title === chatFallbackTitle(row.externalChatId)) {
      row.title = s.displayName
    }
    if (row.windows.length === 0) row.latestSessionId = s.sessionId
    row.windows.push(s)
    // A blocked chat (pending/denied) keeps its first-contact key even when it
    // still carries windows - revokeChatAccess denies but keeps the sessions, and
    // bumping to session recency would re-create the inversion requestedAt prevents.
    if (row.status !== 'pending' && row.status !== 'denied') {
      row.lastActivityAt = Math.max(row.lastActivityAt, new Date(s.updatedAt).getTime())
    }
  }

  // Blocked (pending or denied) rows sink below active/allowed ones; within the
  // blocked group, newest first contact wins (so waiting chats surface, not old denials).
  const rank = (r: ChatRow) => (r.status === 'pending' || r.status === 'denied' ? 1 : 0)
  return [...byChat.values()].sort((a, b) => rank(a) - rank(b) || b.lastActivityAt - a.lastActivityAt)
}

/** Whether a chat has a conversation thread that can be opened. */
export function isBrowsable(row: ChatRow): boolean {
  return row.latestSessionId != null
}

/**
 * The newest non-archived window - the live conversation. Null when every window
 * has been cleared (or there are none yet), i.e. the chat is awaiting a fresh one.
 */
export function activeWindow(row: ChatRow): ChatIntegrationSession | null {
  return row.windows.find((w) => w.archivedAt == null) ?? null
}
