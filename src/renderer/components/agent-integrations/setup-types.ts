import type { PublicAgentIntegration } from '@shared/lib/agent-integrations/public'
import type { ComponentType } from 'react'

export interface IntegrationSetupProps {
  agentSlug: string
  onClose: () => void
}

/** Renderer-only provider definition; independent of host implementations. */
export interface IntegrationSetupProvider {
  platformOnly?: boolean
  slug: string
  label: string
  managementAccess?: 'user' | 'owner'
  Setup: ComponentType<IntegrationSetupProps>
  Settings?: ComponentType<{ integration: PublicAgentIntegration; canManageAccess?: boolean }>
  ConnectionSettings?: ComponentType<{ integration: PublicAgentIntegration }>
  iconClassName?: string
}
