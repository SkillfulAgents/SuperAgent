import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { validateProxyToken } from '@shared/lib/proxy/token-store'
import { agentIntegrationRegistry } from '@shared/lib/agent-integrations/registry'
import { agentIntegrationManager } from '@shared/lib/agent-integrations/agent-integration-manager'
import { IntegrationPolicyError } from '@shared/lib/agent-integrations/errors'
import { integrationSetupContext, prepareIntegrationSetup, setupError } from '@shared/lib/agent-integrations/setup'
import type { AgentIntegrationRecord } from '@shared/lib/agent-integrations/types'
import type { AgentIntegration } from '@shared/lib/agent-integrations/agent-integration'
import {
  createAgentIntegration, getAgentIntegration, listAgentIntegrations, updateAgentIntegrationStatus,
} from '@shared/lib/services/agent-integration-service'
import { MEETING_FAMILY } from '@shared/lib/meeting-integrations/definitions'
import { meetingProviders } from '@shared/lib/meeting-integrations/providers'
import { meetingModeSchema, type PublicMeeting } from '@shared/lib/meeting-integrations/schemas'
import { getMeeting, listMeetings, toPublicMeeting } from '@shared/lib/meeting-integrations/store'
import { captureException } from '@shared/lib/error-reporting'
import { background } from '@shared/lib/background'

/**
 * The agent's own way into meetings: the container's meeting tools call these
 * routes with the agent's proxy token. They drive the meeting family's tools
 * (`join_meeting`, `leave_meeting`, `send_meeting_chat`) on the caller's own
 * installation, and set that installation up on first use when the host can
 * run meeting bots at all, so "join this call and take notes" needs nothing
 * from the integration page first. Reads come straight from the family's store.
 */
type Variables = { callerSlug: string }
const xAgentMeetings = new Hono<{ Variables: Variables }>()

xAgentMeetings.use('*', async (c, next) => {
  const token = c.req.header('Authorization')?.replace('Bearer ', '')
  const callerSlug = token ? await validateProxyToken(token) : null
  if (!callerSlug) return c.json({ error: 'Unauthorized' }, 401)
  c.set('callerSlug', callerSlug)
  await next()
})

const joinSchema = z.object({
  meeting_url: z.string().trim().min(1).max(2048),
  context: z.string().trim().max(4000).optional(),
  mode: meetingModeSchema.optional(),
}).strict()
const meetingIdSchema = z.object({ meeting_id: z.string().uuid() }).strict()
const chatSchema = z.object({ meeting_id: z.string().uuid().optional(), message: z.string().trim().min(1).max(4096) }).strict()
const listSchema = z.object({ limit: z.number().int().min(1).max(50).optional() }).strict()

const SENTRY_TAGS = { component: 'x-agent-meetings' } as const

async function meetingIntegrationsOf(agentSlug: string): Promise<AgentIntegrationRecord[]> {
  return (await listAgentIntegrations(agentSlug)).filter(row => agentIntegrationRegistry.getDefinition(row.provider)?.family === MEETING_FAMILY)
}

/**
 * The caller's meeting installation, made on the spot when it has none. A
 * paused one is the owner's decision and is not worked around; a provider is
 * chosen only when this host can run its bots (public address and bot service).
 */
async function ensureMeetingIntegration(callerSlug: string, request: Request): Promise<{ integration: AgentIntegrationRecord; created: boolean }> {
  const existing = await meetingIntegrationsOf(callerSlug)
  const usable = existing.find(row => row.status === 'active') ?? existing.find(row => row.status === 'error')
  if (usable) return { integration: usable, created: false }
  if (existing.length > 0) throw new IntegrationPolicyError('The meeting integration is paused. The person who manages this agent can resume it from the integration page.')
  let provider: string | undefined
  for (const candidate of meetingProviders) {
    if (await agentIntegrationRegistry.isAvailable(candidate.definition.provider)) { provider = candidate.definition.provider; break }
  }
  if (!provider) throw new IntegrationPolicyError('Meetings are unavailable on this host: it needs a public https address (HOST_PUBLIC_URL) and a Platform connection or a Recall.ai key.')
  const definition = agentIntegrationRegistry.getDefinition(provider)!
  const prepared = await prepareIntegrationSetup(provider, {}, integrationSetupContext(provider, request, callerSlug), true)
  let id: string
  try {
    id = await createAgentIntegration({ agentSlug: callerSlug, provider, name: definition.name, config: prepared.config, status: prepared.status })
  } catch (error) {
    await prepared.release()
    throw error
  }
  try {
    await agentIntegrationManager.addIntegration(id)
  } catch (error) {
    await updateAgentIntegrationStatus(id, 'error', error instanceof Error ? error.message : String(error))
  }
  background(agentIntegrationManager.integrationCreated(id), { name: 'x-agent-meetings-route.integration-created' })
  const integration = await getAgentIntegration(id)
  if (!integration) throw new Error('Meeting integration created but could not be retrieved')
  return { integration, created: true }
}

async function liveConnector(integration: AgentIntegrationRecord): Promise<AgentIntegration | undefined> {
  if (integration.status === 'paused') return undefined
  let connector = agentIntegrationManager.getConnector(integration.id)
  if (!connector) {
    try {
      await agentIntegrationManager.addIntegration(integration.id)
      connector = agentIntegrationManager.getConnector(integration.id)
    } catch { /* reported by the manager */ }
  }
  return connector
}

/** Run one of the family's agent-exposed tools on the caller's installation. */
async function invokeMeetingTool(integration: AgentIntegrationRecord, name: string, input: unknown): Promise<unknown> {
  const connector = await liveConnector(integration)
  if (!connector) throw new IntegrationPolicyError('The meeting integration is not connected.')
  const tool = connector.getTools({ integration, externalId: '' }).find(tool => tool.name === name)
  if (!tool || tool.exposure === 'management') throw new IntegrationPolicyError(`The ${integration.provider} provider does not support ${name}.`)
  return tool.execute(input, { source: 'agent' })
}

/** A meeting of the caller's, with its installation; anyone else's meeting is unknown. */
async function ownMeeting(callerSlug: string, meetingId: string): Promise<{ meetingId: string; integration: AgentIntegrationRecord }> {
  const meeting = await getMeeting(meetingId)
  const integration = meeting && meeting.agentSlug === callerSlug ? await getAgentIntegration(meeting.integrationId) : null
  if (!meeting || !integration) throw new IntegrationPolicyError('Unknown meeting.')
  return { meetingId: meeting.id, integration }
}

function failure(c: Context, error: unknown, operation: string, extra?: Record<string, unknown>): Response {
  if (error instanceof IntegrationPolicyError) return c.json({ error: error.message }, 400)
  const setup = setupError(error)
  if (setup) return c.json({ error: setup.error }, setup.status)
  captureException(error, { tags: { ...SENTRY_TAGS, operation }, extra })
  return c.json({ error: error instanceof Error ? error.message : 'Meeting request failed' }, 500)
}

// POST /join — send a bot into a call for this agent, setting the integration up first when it has none.
xAgentMeetings.post('/join', async (c) => {
  const callerSlug = c.get('callerSlug')
  try {
    const body = joinSchema.parse(await c.req.json())
    const { integration, created } = await ensureMeetingIntegration(callerSlug, c.req.raw)
    const meeting = await invokeMeetingTool(integration, 'join_meeting', { meetingUrl: body.meeting_url, context: body.context, mode: body.mode }) as PublicMeeting
    return c.json({ meeting, integrationId: integration.id, integrationCreated: created })
  } catch (error) {
    return failure(c, error, 'join', { agentSlug: callerSlug })
  }
})

// POST /leave — send the bot home.
xAgentMeetings.post('/leave', async (c) => {
  const callerSlug = c.get('callerSlug')
  try {
    const body = meetingIdSchema.parse(await c.req.json())
    const { meetingId, integration } = await ownMeeting(callerSlug, body.meeting_id)
    const meeting = await invokeMeetingTool(integration, 'leave_meeting', { meetingId }) as PublicMeeting
    return c.json({ meeting })
  } catch (error) {
    return failure(c, error, 'leave', { agentSlug: callerSlug })
  }
})

// POST /chat — post text into a call's chat. Without meeting_id the family picks the one live meeting.
xAgentMeetings.post('/chat', async (c) => {
  const callerSlug = c.get('callerSlug')
  try {
    const body = chatSchema.parse(await c.req.json())
    let integration: AgentIntegrationRecord
    if (body.meeting_id) {
      ({ integration } = await ownMeeting(callerSlug, body.meeting_id))
    } else {
      const candidates = (await meetingIntegrationsOf(callerSlug)).filter(row => row.status !== 'paused')
      if (candidates.length !== 1) throw new IntegrationPolicyError(candidates.length === 0 ? 'This agent has no meeting integration.' : 'Pass meeting_id: this agent has several meeting integrations.')
      integration = candidates[0]
    }
    await invokeMeetingTool(integration, 'send_meeting_chat', { meetingId: body.meeting_id, message: body.message })
    return c.json({ sent: true })
  } catch (error) {
    return failure(c, error, 'chat', { agentSlug: callerSlug })
  }
})

// POST /list — the caller's recent and current meetings across its installations, newest first.
xAgentMeetings.post('/list', async (c) => {
  const callerSlug = c.get('callerSlug')
  try {
    const body = listSchema.parse(await c.req.json().catch(() => ({})))
    const limit = body.limit ?? 20
    const integrations = await meetingIntegrationsOf(callerSlug)
    const meetings = (await Promise.all(integrations.map(row => listMeetings(row.id, limit)))).flat()
      .sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime()).slice(0, limit).map(toPublicMeeting)
    return c.json({ meetings })
  } catch (error) {
    return failure(c, error, 'list', { agentSlug: callerSlug })
  }
})

export default xAgentMeetings
