/**
 * Chat Integration Session Service — maps external chat IDs to agent sessions.
 *
 * Each integration can have multiple chat sessions (e.g. multiple users DMing the same Slack bot).
 */

import { eq, and, isNull, desc } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { chatIntegrationSessions } from '@shared/lib/db/schema'
import type { ChatIntegrationSession, NewChatIntegrationSession } from '@shared/lib/db/schema'

export type { ChatIntegrationSession, NewChatIntegrationSession }

// ── Read ────────────────────────────────────────────────────────────────

/** Get the most recently active (non-archived) session for a chat. Used for message routing. */
export function getChatIntegrationSession(
  integrationId: string,
  externalChatId: string,
): ChatIntegrationSession | null {
  const results = db.select().from(chatIntegrationSessions)
    .where(and(
      eq(chatIntegrationSessions.integrationId, integrationId),
      eq(chatIntegrationSessions.externalChatId, externalChatId),
      isNull(chatIntegrationSessions.archivedAt),
    ))
    .orderBy(desc(chatIntegrationSessions.updatedAt), desc(chatIntegrationSessions.createdAt))
    .limit(1)
    .all()
  return results[0] || null
}

export function getChatIntegrationSessionById(id: string): ChatIntegrationSession | null {
  const results = db.select().from(chatIntegrationSessions)
    .where(eq(chatIntegrationSessions.id, id))
    .all()
  return results[0] || null
}

export function getChatIntegrationSessionBySessionId(sessionId: string): ChatIntegrationSession | null {
  const results = db.select().from(chatIntegrationSessions)
    .where(eq(chatIntegrationSessions.sessionId, sessionId))
    .all()
  return results[0] || null
}

export function listChatIntegrationSessions(integrationId: string): ChatIntegrationSession[] {
  return db.select().from(chatIntegrationSessions)
    .where(eq(chatIntegrationSessions.integrationId, integrationId))
    .all()
}

/**
 * List only the ACTIVE (non-archived) sessions for an integration.
 *
 * Used by the reconnect/restore path so archived/cleared/timed-out sessions are
 * not re-subscribed for SSE forwarding (SUP-233). `listChatIntegrationSessions`
 * intentionally returns archived rows too — the UI/x-agent surfaces filter at
 * the call site — so it is left unchanged.
 */
export function listActiveChatIntegrationSessions(integrationId: string): ChatIntegrationSession[] {
  return db.select().from(chatIntegrationSessions)
    .where(and(
      eq(chatIntegrationSessions.integrationId, integrationId),
      isNull(chatIntegrationSessions.archivedAt),
    ))
    .all()
}

// ── Create ──────────────────────────────────────────────────────────────

export function createChatIntegrationSession(params: {
  integrationId: string
  externalChatId: string
  sessionId: string
  displayName?: string
}): string {
  const id = crypto.randomUUID()
  const now = new Date()

  const record: NewChatIntegrationSession = {
    id,
    integrationId: params.integrationId,
    externalChatId: params.externalChatId,
    sessionId: params.sessionId,
    displayName: params.displayName ?? null,
    createdAt: now,
    updatedAt: now,
  }

  db.insert(chatIntegrationSessions).values(record).run()
  return id
}

// ── Update ──────────────────────────────────────────────────────────────

export function updateChatIntegrationSessionName(id: string, displayName: string): boolean {
  const result = db.update(chatIntegrationSessions)
    .set({ displayName, updatedAt: new Date() })
    .where(eq(chatIntegrationSessions.id, id))
    .run()
  return result.changes > 0
}

/** Bump updatedAt to record last activity (used by session timeout). */
export function touchChatIntegrationSession(id: string): boolean {
  const result = db.update(chatIntegrationSessions)
    .set({ updatedAt: new Date() })
    .where(eq(chatIntegrationSessions.id, id))
    .run()
  return result.changes > 0
}

// ── Session Resolution ────────────────────────────────────────────────

/**
 * Look up the active session for a chat and rotate if it exceeded the timeout.
 * Returns the active session, or null if there is none (or it was rotated).
 *
 * When a session is rotated, it is archived and the returned null signals
 * the caller to create a new session. The archived session's ID is returned
 * via `onArchive` so the caller can do additional cleanup (e.g. SSE teardown).
 */
export function resolveActiveSession(
  integrationId: string,
  chatId: string,
  timeoutHours: number | null | undefined,
  onArchive?: (archivedSessionId: string) => void,
): ChatIntegrationSession | null {
  const session = getChatIntegrationSession(integrationId, chatId)
  if (!session) return null

  if (isSessionTimedOut(session, timeoutHours)) {
    onArchive?.(session.id)
    archiveChatIntegrationSession(session.id)
    return null
  }

  return session
}

function isSessionTimedOut(
  session: { updatedAt: Date | null; createdAt: Date },
  timeoutHours: number | null | undefined,
): boolean {
  if (!timeoutHours || timeoutHours <= 0) return false
  const lastActivity = session.updatedAt?.getTime?.() ?? session.createdAt.getTime()
  const timeoutMs = timeoutHours * 60 * 60 * 1000
  return Date.now() - lastActivity > timeoutMs
}

/**
 * Derive display name for a new session from the most recent session for this chat.
 * Falls back to undefined if no prior sessions exist.
 */
export function getLastDisplayName(integrationId: string, chatId: string): string | undefined {
  const allSessions = listChatIntegrationSessions(integrationId)
  return allSessions
    .filter((s) => s.externalChatId === chatId && s.displayName)
    .sort((a, b) => (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0))[0]
    ?.displayName ?? undefined
}

// ── Archive ────────────────────────────────────────────────────────────

export function archiveChatIntegrationSession(id: string): boolean {
  const result = db.update(chatIntegrationSessions)
    .set({ archivedAt: new Date(), updatedAt: new Date() })
    .where(eq(chatIntegrationSessions.id, id))
    .run()
  return result.changes > 0
}

// ── Delete ──────────────────────────────────────────────────────────────

export function deleteChatIntegrationSession(id: string): boolean {
  const result = db.delete(chatIntegrationSessions)
    .where(eq(chatIntegrationSessions.id, id))
    .run()
  return result.changes > 0
}

export function deleteChatIntegrationSessionsByIntegration(integrationId: string): number {
  const result = db.delete(chatIntegrationSessions)
    .where(eq(chatIntegrationSessions.integrationId, integrationId))
    .run()
  return result.changes
}
