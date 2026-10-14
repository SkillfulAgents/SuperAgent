import { EmailIntegrationMessage } from './messages/email-message'
import { EmailIntegrationSetupForm } from './email-integration-setup-form'
import { EmailSettingsCard } from './email-settings-card'
import { EmailDeliveryCard } from './email-delivery-card'
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
import { IMessageDeliveryCard } from './imessage-delivery-card'
import { LinearIntegrationMessage } from './messages/linear-message'

function chatProvider(slug: ChatProvider, label: string, Message: ComponentType<IntegrationMessageProps>, Settings: IntegrationSetupProvider['Settings'] = ChatIntegrationSettingsCard): IntegrationSetupProvider {
  return { slug, label, Message, Settings, Setup: props => <ChatIntegrationSetupForm {...props} provider={slug} /> }
}

/** Composition point for provider UI; the home list, dialog and transcript only consume definitions. */
export const integrationSetupProviders: readonly IntegrationSetupProvider[] = [
  { slug: 'platform-email', label: 'Email', managementAccess: 'owner', Setup: EmailIntegrationSetupForm, Message: EmailIntegrationMessage, Settings: props => <>
    <EmailSettingsCard {...props} />
    <EmailDeliveryCard integration={props.integration} />
  </> },
  chatProvider('telegram', 'Telegram', TelegramIntegrationMessage),
  chatProvider('slack', 'Slack', SlackIntegrationMessage),
  chatProvider('imessage', 'iMessage', IMessageIntegrationMessage, props => <>
    <ChatIntegrationSettingsCard {...props} />
    <IMessageDeliveryCard integration={props.integration} />
  </>),
  { slug: 'linear', label: 'Linear', managementAccess: 'owner', iconClassName: 'dark:invert', Setup: LinearSetupForm, ConnectionSettings: LinearConnectionSettings, Settings: LinearIntegrationSettings, Message: LinearIntegrationMessage },

]
