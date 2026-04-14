/**
 * Chat Integration Session Service — maps external chat IDs to agent sessions.
 *
 * Each integration can have multiple chat sessions (e.g. multiple users DMing the same Slack bot).
 */

import { eq, and, isNull } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { chatIntegrationSessions } from '@shared/lib/db/schema'
import type { ChatIntegrationSession, NewChatIntegrationSession } from '@shared/lib/db/schema'

export type { ChatIntegrationSession, NewChatIntegrationSession }

// ── Read ────────────────────────────────────────────────────────────────

/** Get the active (non-archived) session for a chat. Used for message routing. */
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
