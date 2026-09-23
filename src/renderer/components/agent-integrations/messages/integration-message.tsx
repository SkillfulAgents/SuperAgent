import type { UserMessageRenderProps } from '@renderer/components/messages/user-message-kinds/types'
import { integrationSetupProviders } from '../setup-providers'
import { GenericIntegrationMessage } from './generic-message'

/**
 * The transcript's card for a message an integration delivered. The provider
 * registered for the stored provider key draws it; an unknown, removed or
 * preview-less provider gets the generic card. Never parses the message text.
 */
export function IntegrationMessage({ message, renderMarkdown }: UserMessageRenderProps) {
  const display = message.integration
  if (!display) return null
  const provider = integrationSetupProviders.find((entry) => entry.slug === display.integration.provider)
  const Preview = provider?.Message ?? GenericIntegrationMessage
  return <Preview display={display} message={message} renderMarkdown={renderMarkdown} iconClassName={provider?.iconClassName} />
}
