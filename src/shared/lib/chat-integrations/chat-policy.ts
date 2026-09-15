import { z } from 'zod'
import type { AgentIntegration } from '../agent-integrations/agent-integration'
import type { AgentIntegrationRecord, IntegrationRoute, IntegrationSessionContext, IntegrationSessionPolicy } from '../agent-integrations/types'
import { isChatAllowed } from '../services/chat-integration-access-service'
import { formatSessionTimestamp } from './utils'

// Read both the existing database columns and an explicit family settings envelope.
const chatSettingsSchema = z.object({ showToolCalls: z.boolean().default(false), sessionTimeout: z.number().nullable().default(null) })
export function chatSettings(integration: AgentIntegrationRecord) {
  return chatSettingsSchema.parse(integration.settings ?? integration)
}

/** Shared policy for live adapters and session recording during reconnection. */
export const chatIntegrationPolicy: Pick<AgentIntegration, 'isAllowed' | 'sessionPolicy'> = {
  isAllowed(context: IntegrationSessionContext): boolean {
    return isChatAllowed(context.integration.id, context.externalId)
  },

  sessionPolicy(integration: AgentIntegrationRecord, route: Partial<IntegrationRoute>): IntegrationSessionPolicy {
    const { sessionTimeout } = chatSettings(integration)
    return {
      timeoutHours: sessionTimeout,
      name: buildSessionName(integration.name, integration.provider, route.displayName, sessionTimeout),
      metadata: { isChatIntegrationSession: true, chatIntegrationId: integration.id },
    }
  },
}

/** Build the session name, appending a timestamp when session rotation is enabled. */
export function buildSessionName(
  integrationName: string | null,
  provider: string,
  displayName: string | undefined,
  timeoutHours: number | null | undefined,
  now: Date = new Date(),
): string {
  const baseName = displayName
    ? `${integrationName || provider} — ${displayName}`
    : integrationName || `${provider} chat`

  if (timeoutHours && timeoutHours > 0) {
    return `${baseName} — ${formatSessionTimestamp(now)}`
  }
  return baseName
}
