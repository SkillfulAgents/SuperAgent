/**
 * Compatibility adapter over the existing installation/session tables. Keeping
 * these rows in place preserves credentials, IDs, access approvals, transcripts,
 * and API clients without a data migration or reconnect wizard.
 */
import * as installations from '../services/agent-integration-service'
import * as sessions from '../services/agent-integration-session-service'
import type { AgentIntegrationRecord, IntegrationStatus } from './types'

type StoredSession = sessions.AgentIntegrationSession
export type IntegrationSessionRecord = Omit<StoredSession, 'externalChatId'> & { externalId: string }

function sessionRecord(row: StoredSession): IntegrationSessionRecord {
  const { externalChatId, ...rest } = row
  return { ...rest, externalId: externalChatId }
}

export function listStartupIntegrations(): Promise<AgentIntegrationRecord[]> { return installations.listStartupAgentIntegrations() }
export function getIntegration(id: string): Promise<AgentIntegrationRecord | null> { return installations.getAgentIntegration(id) }
export function updateIntegrationStatus(...args: [id: string, status: IntegrationStatus, error?: string | null, expectedConfig?: string]) {
  const [id, status, error, expectedConfig] = args
  if (status !== 'active') return installations.updateAgentIntegrationStatus(id, status, error)
  return installations.updateAgentIntegrationStatus(id, status, error,
    expectedConfig === undefined ? { unlessDisconnected: true } : { config: expectedConfig })
}
export async function getIntegrationSession(id: string, externalId: string) {
  const row = await sessions.getAgentIntegrationSession(id, externalId)
  return row ? sessionRecord(row) : null
}
export async function getIntegrationSessionBySessionId(agentSlug: string, sessionId: string) {
  const row = await sessions.getAgentIntegrationSessionBySessionId(agentSlug, sessionId)
  return row ? sessionRecord(row) : null
}
export async function listIntegrationSessions(id: string) { return (await sessions.listAgentIntegrationSessions(id)).map(sessionRecord) }
export async function listActiveIntegrationSessions(id: string) { return (await sessions.listActiveAgentIntegrationSessions(id)).map(sessionRecord) }
export async function resolveActiveSession(id: string, externalId: string, timeoutHours: number | null | undefined, onArchive: (id: string) => void) {
  const row = await sessions.resolveActiveSession(id, externalId, timeoutHours, onArchive)
  return row ? sessionRecord(row) : null
}
export function createIntegrationSession({ externalId, ...rest }: { integrationId: string; externalId: string; sessionId: string; displayName?: string }) {
  return sessions.createAgentIntegrationSession({ ...rest, externalChatId: externalId })
}
export function updateIntegrationSessionName(id: string, name: string) { return sessions.updateAgentIntegrationSessionName(id, name) }
export function archiveIntegrationSession(id: string) { return sessions.archiveAgentIntegrationSession(id) }
export function touchIntegrationSession(id: string) { return sessions.touchAgentIntegrationSession(id) }
export function getLastDisplayName(id: string, externalId: string) { return sessions.getLastDisplayName(id, externalId) }
