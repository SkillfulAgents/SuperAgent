import type { AgentIntegrationRecord } from '../agent-integrations/types'
import { getAgentIntegrationSession } from '../services/agent-integration-session-service'
import type { EmailMessage } from './config-schema'

/** Reuse existing session mappings; the gateway owns canonical thread redirects and lists them with the message. */
export async function emailThreadRoute(record: AgentIntegrationRecord, message: Pick<EmailMessage, 'threadId' | 'threadAliases'>): Promise<string> {
  for (const threadId of [message.threadId, ...(message.threadAliases ?? [])]) {
    if (await getAgentIntegrationSession(record.id, threadId)) return threadId
  }
  return message.threadId
}
