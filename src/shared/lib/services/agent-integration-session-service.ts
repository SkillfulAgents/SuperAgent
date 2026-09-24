/**
 * Agent Integration Session Service — maps external targets to agent sessions.
 *
 * Each integration can have multiple external sessions. The legacy table and
 * externalChatId field names are retained for storage and API compatibility.
 */

import { eq, and, isNull, desc } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { changesOf } from '@shared/lib/db/batch'
import { chatIntegrationSessions, chatIntegrations } from '@shared/lib/db/schema'
import type { AgentIntegrationSession, NewAgentIntegrationSession } from '@shared/lib/db/schema'

export type { AgentIntegrationSession, NewAgentIntegrationSession }

// ── Read ────────────────────────────────────────────────────────────────

/** Get the most recently active (non-archived) session for an external target. Used for message routing. */
export async function getAgentIntegrationSession(
  integrationId: string,
  externalChatId: string,
): Promise<AgentIntegrationSession | null> {
  const results = await db.select().from(chatIntegrationSessions)
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

export async function getAgentIntegrationSessionById(id: string): Promise<AgentIntegrationSession | null> {
  const results = await db.select().from(chatIntegrationSessions)
    .where(eq(chatIntegrationSessions.id, id))
    .all()
  return results[0] || null
}

/**
 * The integration session for `sessionId` that belongs to `agentSlug`.
 *
 * A session id is unique only within an agent — import/clone gives two agents
 * the same id — so a bare-id lookup could return another agent's integration session,
 * routing one agent's approval card into a different agent's external target. Joining
 * to the owning integration and filtering on its agent keeps the answer inside
 * the asking agent.
 */
export async function getAgentIntegrationSessionBySessionId(
  agentSlug: string,
  sessionId: string,
): Promise<AgentIntegrationSession | null> {
  const results = await db.select().from(chatIntegrationSessions)
    .innerJoin(chatIntegrations, eq(chatIntegrationSessions.integrationId, chatIntegrations.id))
    .where(and(
      eq(chatIntegrationSessions.sessionId, sessionId),
      eq(chatIntegrations.agentSlug, agentSlug),
    ))
    .all()
  return results[0]?.chat_integration_sessions ?? null
}

export async function listAgentIntegrationSessions(integrationId: string): Promise<AgentIntegrationSession[]> {
  return db.select().from(chatIntegrationSessions)
    .where(eq(chatIntegrationSessions.integrationId, integrationId))
    .all()
}

/**
 * List only the ACTIVE (non-archived) sessions for an integration.
 *
 * Used by the reconnect/restore path so archived/cleared/timed-out sessions are
 * not re-subscribed for SSE forwarding (SUP-233). `listAgentIntegrationSessions`
 * intentionally returns archived rows too — the UI/x-agent surfaces filter at
 * the call site — so it is left unchanged.
 */
export async function listActiveAgentIntegrationSessions(integrationId: string): Promise<AgentIntegrationSession[]> {
  return db.select().from(chatIntegrationSessions)
    .where(and(
      eq(chatIntegrationSessions.integrationId, integrationId),
      isNull(chatIntegrationSessions.archivedAt),
    ))
    .all()
}

// ── Create ──────────────────────────────────────────────────────────────

export async function createAgentIntegrationSession(params: {
  integrationId: string
  externalChatId: string
  sessionId: string
  displayName?: string
}): Promise<string> {
  const id = crypto.randomUUID()
  const now = new Date()

  const record: NewAgentIntegrationSession = {
    id,
    integrationId: params.integrationId,
    externalChatId: params.externalChatId,
    sessionId: params.sessionId,
    displayName: params.displayName ?? null,
    createdAt: now,
    updatedAt: now,
  }

  await db.insert(chatIntegrationSessions).values(record).run()
  return id
}

// ── Update ──────────────────────────────────────────────────────────────

export async function updateAgentIntegrationSessionName(id: string, displayName: string): Promise<boolean> {
  const result = await db.update(chatIntegrationSessions)
    .set({ displayName, updatedAt: new Date() })
    .where(eq(chatIntegrationSessions.id, id))
    .run()
  return changesOf(result) > 0
}

/** Bump updatedAt to record last activity (used by session timeout). */
export async function touchAgentIntegrationSession(id: string): Promise<boolean> {
  const result = await db.update(chatIntegrationSessions)
    .set({ updatedAt: new Date() })
    .where(eq(chatIntegrationSessions.id, id))
    .run()
  return changesOf(result) > 0
}

// ── Session Resolution ────────────────────────────────────────────────

/**
 * Look up the active session for an external target and rotate if it exceeded the timeout.
 * Returns the active session, or null if there is none (or it was rotated).
 *
 * When a session is rotated, it is archived and the returned null signals
 * the caller to create a new session. The archived session's ID is returned
 * via `onArchive` so the caller can do additional cleanup (e.g. SSE teardown).
 */
export async function resolveActiveSession(
  integrationId: string,
  externalId: string,
  timeoutHours: number | null | undefined,
  onArchive?: (archivedSessionId: string) => void,
): Promise<AgentIntegrationSession | null> {
  const session = await getAgentIntegrationSession(integrationId, externalId)
  if (!session) return null

  if (isSessionTimedOut(session, timeoutHours)) {
    onArchive?.(session.id)
    await archiveAgentIntegrationSession(session.id)
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
 * Derive display name for a new session from the most recent session for this external target.
 * Falls back to undefined if no prior sessions exist.
 */
export async function getLastDisplayName(integrationId: string, externalId: string): Promise<string | undefined> {
  const allSessions = await listAgentIntegrationSessions(integrationId)
  return allSessions
    .filter((s) => s.externalChatId === externalId && s.displayName)
    .sort((a, b) => (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0))[0]
    ?.displayName ?? undefined
}

// ── Archive ────────────────────────────────────────────────────────────

export async function archiveAgentIntegrationSession(id: string): Promise<boolean> {
  const result = await db.update(chatIntegrationSessions)
    .set({ archivedAt: new Date(), updatedAt: new Date() })
    .where(eq(chatIntegrationSessions.id, id))
    .run()
  return changesOf(result) > 0
}

// ── Delete ──────────────────────────────────────────────────────────────

export async function deleteAgentIntegrationSession(id: string): Promise<boolean> {
  const result = await db.delete(chatIntegrationSessions)
    .where(eq(chatIntegrationSessions.id, id))
    .run()
  return changesOf(result) > 0
}

export async function deleteAgentIntegrationSessionsByIntegration(integrationId: string): Promise<number> {
  const result = await db.delete(chatIntegrationSessions)
    .where(eq(chatIntegrationSessions.integrationId, integrationId))
    .run()
  return changesOf(result)
}
