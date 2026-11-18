import type { PublicAgentIntegration } from '../../agent-integrations/public'

export type PublicGitHubIntegration = PublicAgentIntegration<{
  account?: string
  botLogin?: string
  appName?: string
  appUrl?: string
}>
export function isPublicGitHubIntegration(integration: PublicAgentIntegration): integration is PublicGitHubIntegration { return integration.provider === 'github' }
