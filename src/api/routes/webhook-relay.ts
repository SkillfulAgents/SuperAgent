import { Hono } from 'hono'
import { getWebhookRelay, toWebhookRelayStatus } from '@shared/lib/webhook-relay'
import { Authenticated } from '../middleware/auth'

const webhookRelay = new Hono()

webhookRelay.use('*', Authenticated())

// GET /api/webhook-relay - whether this host can receive webhooks, and how.
// Changes arrive on the notification stream as `webhook_relay_changed`.
webhookRelay.get('/', (c) => c.json(toWebhookRelayStatus(getWebhookRelay().snapshot())))

export default webhookRelay
