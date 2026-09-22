import { ChatIntegrationSettingsCard } from './chat-integration-settings-card'
import type { ChatProvider } from '@shared/lib/chat-integrations/config-schema'
import { ChatIntegrationSetupForm } from './chat-integration-setup-form'
import type { IntegrationSetupProvider } from './setup-types'

function chatProvider(slug: ChatProvider, label: string): IntegrationSetupProvider {
  return { slug, label, Settings: ChatIntegrationSettingsCard, Setup: props => <ChatIntegrationSetupForm {...props} provider={slug} /> }
}

/** Composition point for setup forms; the home list and dialog only consume definitions. */
export const integrationSetupProviders: readonly IntegrationSetupProvider[] = [
  chatProvider('telegram', 'Telegram'),
  chatProvider('slack', 'Slack'),
  chatProvider('imessage', 'iMessage'),
]
