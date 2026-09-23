import { EmailIntegrationMessage } from './messages/email-message'
import { EmailIntegrationSetupForm } from './email-integration-setup-form'
import { EmailSettingsCard } from './email-settings-card'
import type { ComponentType } from 'react'
import { LinearSetupForm, LinearConnectionSettings, LinearIntegrationSettings } from './linear-setup'
import { ChatIntegrationSettingsCard } from './chat-integration-settings-card'
import type { ChatProvider } from '@shared/lib/chat-integrations/config-schema'
import { ChatIntegrationSetupForm } from './chat-integration-setup-form'
import type { IntegrationSetupProvider } from './setup-types'
import type { IntegrationMessageProps } from './messages/types'
import { SlackIntegrationMessage } from './messages/slack-message'
import { TelegramIntegrationMessage } from './messages/telegram-message'
import { IMessageIntegrationMessage } from './messages/imessage-message'
import { LinearIntegrationMessage } from './messages/linear-message'

function chatProvider(slug: ChatProvider, label: string, Message: ComponentType<IntegrationMessageProps>): IntegrationSetupProvider {
  return { slug, label, Message, Settings: ChatIntegrationSettingsCard, Setup: props => <ChatIntegrationSetupForm {...props} provider={slug} /> }
}

/** Composition point for provider UI; the home list, dialog and transcript only consume definitions. */
export const integrationSetupProviders: readonly IntegrationSetupProvider[] = [
  { slug: 'platform-email', label: 'Email', managementAccess: 'owner', platformOnly: true, Setup: EmailIntegrationSetupForm, Settings: EmailSettingsCard, Message: EmailIntegrationMessage },
  chatProvider('telegram', 'Telegram', TelegramIntegrationMessage),
  chatProvider('slack', 'Slack', SlackIntegrationMessage),
  chatProvider('imessage', 'iMessage', IMessageIntegrationMessage),
  { slug: 'linear', label: 'Linear', managementAccess: 'owner', iconClassName: 'dark:invert', Setup: LinearSetupForm, ConnectionSettings: LinearConnectionSettings, Settings: LinearIntegrationSettings, Message: LinearIntegrationMessage },

]
