import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { and, eq, ne, sql } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { chatIntegrations } from '@shared/lib/db/schema'
import { agentIntegrationManager } from '@shared/lib/agent-integrations/agent-integration-manager'
import type { ContentfulStatusCode } from 'hono/utils/http-status'

/** Authenticated by Microsoft's Bot Connector service, independent of the browser session. */
const teamsMessages = new Hono()
teamsMessages.post('/:appId', bodyLimit({ maxSize: 1024 * 1024 }), async c => {
  const authorization = c.req.header('Authorization')
  if (!authorization || !/^Bearer [^\s]+$/i.test(authorization)) return c.body(null, 401)
  const activity: unknown = await c.req.json().catch(() => null)
  const { teamsActivityIdentity } = await import('@shared/lib/chat-integrations/teams-api')
  const identity = teamsActivityIdentity(activity)
  if (!identity || identity.appId !== c.req.param('appId').toLowerCase()) return c.body(null, 400)

  // Select only the installation id. The secret and the verifier live on its running connector.
  const installation = await db.select({ id: chatIntegrations.id }).from(chatIntegrations).where(and(
    eq(chatIntegrations.provider, 'teams'),
    ne(chatIntegrations.status, 'paused'),
    sql`CASE WHEN json_valid(${chatIntegrations.config}) THEN (
      json_extract(${chatIntegrations.config}, '$.appId') = ${identity.appId}
      AND json_extract(${chatIntegrations.config}, '$.tenantId') = ${identity.tenantId}
      AND coalesce(json_extract(${chatIntegrations.config}, '$.deliveryMode'), 'https') = 'https'
      AND json_extract(${chatIntegrations.config}, '$.relay') IS NULL
    ) END`,
  )).get()
  if (!installation) return c.body(null, 404)
  const { TeamsConnector } = await import('@shared/lib/chat-integrations/teams-connector')
  const connector = agentIntegrationManager.getConnector(installation.id)
  if (!(connector instanceof TeamsConnector)) return c.body(null, 503)
  try {
    await connector.api.authenticate(authorization, activity)
  } catch {
    return c.body(null, 401)
  }
  if (agentIntegrationManager.getConnector(installation.id) !== connector) return c.body(null, 503)
  const result = await connector.acceptActivity(activity)
  if (typeof result === 'object') {
    if (result.body !== undefined) return c.json(result.body, result.status as ContentfulStatusCode)
    return c.body(null, result.status as ContentfulStatusCode)
  }
  if (result === 'retry') return c.body(null, 503)
  if (result === 'rejected') return c.body(null, 400)
  return c.body(null, 200)
})

export default teamsMessages
