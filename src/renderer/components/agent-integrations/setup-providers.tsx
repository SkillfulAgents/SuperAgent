import { EmailIntegrationSetupForm } from './email-integration-setup-form'
import { EmailSettingsCard } from './email-settings-card'
import { LinearSetupForm, LinearConnectionSettings, LinearIntegrationSettings } from './linear-setup'
import { ChatIntegrationSettingsCard } from './chat-integration-settings-card'
import type { ChatProvider } from '@shared/lib/chat-integrations/config-schema'
import { ChatIntegrationSetupForm } from './chat-integration-setup-form'
import type { IntegrationSetupProvider } from './setup-types'

function chatProvider(slug: ChatProvider, label: string): IntegrationSetupProvider {
  return { slug, label, Settings: ChatIntegrationSettingsCard, Setup: props => <ChatIntegrationSetupForm {...props} provider={slug} /> }
}

/** Composition point for setup forms; the home list and dialog only consume definitions. */
export const integrationSetupProviders: readonly IntegrationSetupProvider[] = [
  { slug: 'platform-email', label: 'Email', managementAccess: 'owner', platformOnly: true, Setup: EmailIntegrationSetupForm, Settings: EmailSettingsCard },
  chatProvider('telegram', 'Telegram'),
  chatProvider('slack', 'Slack'),
  chatProvider('imessage', 'iMessage'),
  { slug: 'linear', label: 'Linear', managementAccess: 'owner', iconClassName: 'dark:invert', Setup: LinearSetupForm, ConnectionSettings: LinearConnectionSettings, Settings: LinearIntegrationSettings },
]
