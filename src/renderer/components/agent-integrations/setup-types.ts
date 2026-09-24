import type { PublicAgentIntegration } from '@shared/lib/agent-integrations/public'
import type { ComponentType } from 'react'
import type { IntegrationMessageProps } from './messages/types'

export interface IntegrationSetupProps {
  agentSlug: string
  onClose: () => void
}

/** Renderer-only provider definition; independent of host implementations. */
export interface IntegrationSetupProvider {
  platformOnly?: boolean
  /** Receives events only through the host's webhook relay, so it's hidden while the relay is unavailable. */
  requiresRelay?: boolean
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
