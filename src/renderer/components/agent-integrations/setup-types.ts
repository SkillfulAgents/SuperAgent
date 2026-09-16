import type { ComponentType } from 'react'

export interface IntegrationSetupProps {
  agentSlug: string
  onClose: () => void
}

/** Renderer-only provider definition; independent of host implementations. */
export interface IntegrationSetupProvider {
  slug: string
  label: string
  managementAccess?: 'user' | 'owner'
  Setup: ComponentType<IntegrationSetupProps>
}
