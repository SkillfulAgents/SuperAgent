import type { AgentIntegrationRecord } from '../agent-integrations/types'
import { listActiveAgentIntegrationSessions } from '../services/agent-integration-session-service'
import { parseEmailConfig } from './config-schema'
import { clientFor, EmailGatewayError } from './gateway-client'

/** Reuse existing session mappings; the gateway owns canonical thread redirects. */
export async function emailThreadRoute(record: AgentIntegrationRecord, canonicalId: string): Promise<string> {
  const sessions = await listActiveAgentIntegrationSessions(record.id)
  if (sessions.some(session => session.externalChatId === canonicalId)) return canonicalId
  const client = clientFor(record)
  const { mailboxId } = parseEmailConfig(record.config)
  for (const session of sessions) {
    try {
      if (await client.canonicalThreadId(mailboxId, session.externalChatId) === canonicalId) return session.externalChatId
    } catch (error) {
      if (!(error instanceof EmailGatewayError) || error.status !== 404) throw error
    }
  }
  return canonicalId
}
