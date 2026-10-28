import { GitHubSetupForm, GitHubConnectionSettings } from './github-setup'
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
import { TelegramDeliveryCard } from './telegram-delivery-card'
import { SlackDeliveryCard } from './slack-delivery-card'
import { SlackConnectionSettings, SlackSetup } from './slack-setup'
import { LinearIntegrationMessage } from './messages/linear-message'
import { RecallSetupForm } from './recall-setup-form'
import { MeetingPanel } from './meeting-panel'
import { MeetingSettingsCard } from './meeting-settings-card'

function chatProvider(slug: ChatProvider, label: string, Message: ComponentType<IntegrationMessageProps>, Settings: IntegrationSetupProvider['Settings'] = ChatIntegrationSettingsCard): IntegrationSetupProvider {
  return { slug, label, Message, Settings, Setup: props => <ChatIntegrationSetupForm {...props} provider={slug} /> }
}

/** Composition point for provider UI; the home list, dialog and transcript only consume definitions. */
export const integrationSetupProviders: readonly IntegrationSetupProvider[] = [
  { slug: 'platform-email', label: 'Email', managementAccess: 'owner', Setup: EmailIntegrationSetupForm, Message: EmailIntegrationMessage, Settings: props => <>
    <EmailSettingsCard {...props} />
    <EmailDeliveryCard integration={props.integration} />
  </> },
  chatProvider('telegram', 'Telegram', TelegramIntegrationMessage, props => <>
    <ChatIntegrationSettingsCard {...props} />
    <TelegramDeliveryCard integration={props.integration} />
  </>),
  { ...chatProvider('slack', 'Slack', SlackIntegrationMessage, props => <>
    <ChatIntegrationSettingsCard {...props} />
    <SlackDeliveryCard integration={props.integration} />
  </>), Setup: SlackSetup, ConnectionSettings: SlackConnectionSettings },
  chatProvider('imessage', 'iMessage', IMessageIntegrationMessage, props => <>
    <ChatIntegrationSettingsCard {...props} />
    <IMessageDeliveryCard integration={props.integration} />
  </>),
  { slug: 'github', label: 'GitHub', managementAccess: 'owner', iconClassName: 'dark:invert', Setup: GitHubSetupForm, ConnectionSettings: GitHubConnectionSettings },
  { slug: 'linear', label: 'Linear', managementAccess: 'owner', iconClassName: 'dark:invert', Setup: LinearSetupForm, ConnectionSettings: LinearConnectionSettings, Settings: LinearIntegrationSettings, Message: LinearIntegrationMessage },
  { slug: 'recall', label: 'Meetings', managementAccess: 'owner', Setup: RecallSetupForm, ConnectionSettings: MeetingPanel, Settings: MeetingSettingsCard },

]
