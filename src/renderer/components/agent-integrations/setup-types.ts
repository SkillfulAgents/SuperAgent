import type { PublicAgentIntegration } from '@shared/lib/agent-integrations/public'
import type { OwnerSetupPrefill } from '@shared/lib/agent-integrations/owner-setup-schema'
import type { ComponentType } from 'react'
import type { IntegrationMessageProps } from './messages/types'

export interface IntegrationSetupProps {
  agentSlug: string
  onClose: () => void
  /** Starting values the agent suggested when it asked for this integration. */
  initial?: OwnerSetupPrefill
  /** Replaces opening the new integration's page, for setup started from a session. */
  onCreated?: (integrationId: string) => void
}

/**
 * Renderer-only provider definition; independent of host implementations.
 * Whether a provider can be set up on this deployment is the server's answer
 * (`/api/agent-integrations/providers`), not a flag here.
 */
export interface IntegrationSetupProvider {
  slug: string
  label: string
  managementAccess?: 'user' | 'owner'
  Setup: ComponentType<IntegrationSetupProps>
  Settings?: ComponentType<{ integration: PublicAgentIntegration; canManageAccess?: boolean }>
  ConnectionSettings?: ComponentType<{ integration: PublicAgentIntegration }>
  /** Preview of a message this provider delivered into a session; the generic card otherwise. */
  Message?: ComponentType<IntegrationMessageProps>
  iconClassName?: string
}
