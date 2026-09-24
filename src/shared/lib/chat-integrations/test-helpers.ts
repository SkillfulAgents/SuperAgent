import { MockChatAgentIntegration } from './mock-connector'
import type { IncomingMessage } from './chat-agent-integration'
import type { IntegrationInputEvent } from '../agent-integrations/types'

export function inputEvent(message: Partial<IncomingMessage> & Pick<IncomingMessage, 'chatId'>): IntegrationInputEvent {
  const payload: IncomingMessage = { externalMessageId: 'test-message', text: '', userId: 'test-user', timestamp: new Date(), ...message }
  return { type: 'input', id: payload.externalMessageId, externalId: payload.chatId, timestamp: payload.timestamp, payload }
}

export function mockChatIntegration<T extends object>(overrides: T) {
  return Object.assign(new MockChatAgentIntegration(), overrides)
}
