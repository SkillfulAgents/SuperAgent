import { createHmac } from 'node:crypto'
import { MockChatAgentIntegration } from './mock-connector'
import type { IncomingMessage } from './chat-agent-integration'
import type { IntegrationInputEvent } from '../agent-integrations/types'
import type { RelayEvent } from '../webhook-relay'

export function inputEvent(message: Partial<IncomingMessage> & Pick<IncomingMessage, 'chatId'>): IntegrationInputEvent {
  const payload: IncomingMessage = { externalMessageId: 'test-message', text: '', userId: 'test-user', timestamp: new Date(), ...message }
  return { type: 'input', id: payload.externalMessageId, externalId: payload.chatId, timestamp: payload.timestamp, payload }
}

export function mockChatIntegration<T extends object>(overrides: T) {
  return Object.assign(new MockChatAgentIntegration(), overrides)
}

/** An iMessage gateway webhook delivery as the relay hands it over, signed the way the gateway signs it. */
export function relayedIMessageDelivery(body: Record<string, unknown>, secret: string, options: { timestamp?: string; base64?: boolean } = {}): RelayEvent {
  const raw = JSON.stringify(body)
  const timestamp = options.timestamp ?? String(Math.floor(Date.now() / 1000))
  const signature = createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex')
  return {
    id: `whe_${String(body.id)}`,
    endpointId: 'whep_1',
    type: 'CUSTOM_WEBHOOK',
    createdAt: new Date().toISOString(),
    payload: {
      kind: 'event', verified: true,
      headers: { 'x-imsgw-signature': signature, 'x-imsgw-timestamp': timestamp, 'x-imsgw-event-id': String(body.id) },
      body: options.base64 ? Buffer.from(raw).toString('base64') : raw,
      body_encoding: options.base64 ? 'base64' : 'utf8',
    },
  }
}
