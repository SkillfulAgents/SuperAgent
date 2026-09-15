/**
 * Compatibility adapter over the existing installation/session tables. Keeping
 * these rows in place preserves credentials, IDs, access approvals, transcripts,
 * and API clients without a data migration or reconnect wizard.
 */
import * as installations from '../services/chat-integration-service'
import * as sessions from '../services/chat-integration-session-service'
import type { AgentIntegrationRecord, IntegrationStatus } from './types'

type StoredSession = sessions.ChatIntegrationSession
export type IntegrationSessionRecord = Omit<StoredSession, 'externalChatId'> & { externalId: string }

function sessionRecord(row: StoredSession): IntegrationSessionRecord {
  const { externalChatId, ...rest } = row
  return { ...rest, externalId: externalChatId }
}

export function listStartupIntegrations(): AgentIntegrationRecord[] { return installations.listStartupChatIntegrations() }
export function getIntegration(id: string): AgentIntegrationRecord | null { return installations.getChatIntegration(id) }
export function updateIntegrationStatus(...args: [id: string, status: IntegrationStatus, error?: string | null]) {
  return installations.updateChatIntegrationStatus(...args)
}
export function getIntegrationSession(id: string, externalId: string) {
  const row = sessions.getChatIntegrationSession(id, externalId)
  return row ? sessionRecord(row) : null
}
export function getIntegrationSessionBySessionId(agentSlug: string, sessionId: string) {
  const row = sessions.getChatIntegrationSessionBySessionId(agentSlug, sessionId)
  return row ? sessionRecord(row) : null
}
export function listIntegrationSessions(id: string) { return sessions.listChatIntegrationSessions(id).map(sessionRecord) }
export function listActiveIntegrationSessions(id: string) { return sessions.listActiveChatIntegrationSessions(id).map(sessionRecord) }
export function resolveActiveSession(id: string, externalId: string, timeoutHours: number | null | undefined, onArchive: (id: string) => void) {
  const row = sessions.resolveActiveSession(id, externalId, timeoutHours, onArchive)
  return row ? sessionRecord(row) : null
}
export function createIntegrationSession({ externalId, ...rest }: { integrationId: string; externalId: string; sessionId: string; displayName?: string }) {
  return sessions.createChatIntegrationSession({ ...rest, externalChatId: externalId })
}
export function updateIntegrationSessionName(id: string, name: string) { return sessions.updateChatIntegrationSessionName(id, name) }
export function archiveIntegrationSession(id: string) { return sessions.archiveChatIntegrationSession(id) }
export function touchIntegrationSession(id: string) { return sessions.touchChatIntegrationSession(id) }
export function getLastDisplayName(id: string, externalId: string) { return sessions.getLastDisplayName(id, externalId) }
