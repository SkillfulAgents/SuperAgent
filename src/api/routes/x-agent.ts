/**
 * X-Agent Work routes
 *
 * Container-to-host endpoints for cross-agent operations (create / list /
 * invoke / read sessions). Mounted under /api/x-agent (separate from /api/agents
 * to avoid the /:id middleware that requires an existing agent slug in the URL).
 * Also serves the caller's own members.
 *
 * Auth: every request must carry the calling agent's proxy token via Authorization:
 * Bearer <token>. The route resolves the caller's agent slug from that token, and
 * the cross-agent routes apply xAgentPolicies + ACLs accordingly.
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { randomUUID } from 'crypto'
import { db } from '@shared/lib/db'
import { agentAcl } from '@shared/lib/db/schema'
import { isAuthMode } from '@shared/lib/auth/mode'
import { requireAgentCaller } from '../middleware/agent-caller'
import { createAgent } from '@shared/lib/services/agent-service'
import { EFFORT_LEVELS, SPEED_LEVELS } from '@shared/lib/container/types'
import { announceAgentCreated } from '@shared/lib/services/collaboration-events'
import { listAgentMembers } from '@shared/lib/services/agent-members-service'
import {
  xAgentAttachmentsSchema,
  xAgentDownloadFileBodySchema,
} from '@shared/lib/services/x-agent-attachment-schema'
import {
  agentXAgentCaller,
  checkAgentPolicy,
  getOwnersOfAgent,
} from '@shared/lib/services/x-agent/caller'
import {
  getTargetSessions,
  getTargetTranscript,
  listVisibleAgents,
  openDeliveredFile,
} from '@shared/lib/services/x-agent/operations'
import { invokeAgent } from '@shared/lib/services/x-agent/invoke'

// Kept here for the route's tests, which pin the env override's bounds.
export { resolveSyncWaitTimeoutMs } from '@shared/lib/services/x-agent/sync-wait'

// Typed context variables for the x-agent router. Using Hono's generic instead
// of `as never` casts gives us type safety on c.get/c.set.
type XAgentVariables = { callerSlug: string }

const xAgent = new Hono<{ Variables: XAgentVariables }>()

// ----------------------------------------------------------------------------
// Auth: resolve caller agent slug from Bearer token (proxy token)
// ----------------------------------------------------------------------------

xAgent.use('*', requireAgentCaller)

function getCallerSlug(c: { get: (k: 'callerSlug') => string }): string {
  return c.get('callerSlug')
}

// ----------------------------------------------------------------------------
// POST /api/x-agent/list - list agents visible to caller
// ----------------------------------------------------------------------------

xAgent.post('/list', async (c) => {
  const result = await listVisibleAgents(agentXAgentCaller(getCallerSlug(c)))
  if (!result.ok) return c.json({ error: result.error }, result.status)
  return c.json(result.value)
})

// ----------------------------------------------------------------------------
// POST /api/x-agent/members - the caller's own members. Not reviewed: every
// member of the agent can already read this roster.
// ----------------------------------------------------------------------------

// Bounds the agent's context, as chat directory listings do.
const MAX_LISTED_MEMBERS = 500

xAgent.post('/members', async (c) => {
  if (!isAuthMode()) return c.json({ truncated: false, members: [] })
  const members = await listAgentMembers(getCallerSlug(c))
  return c.json({
    truncated: members.length > MAX_LISTED_MEMBERS,
    members: members.slice(0, MAX_LISTED_MEMBERS).map(({ id, name, email, role, invited }) => ({ id, name, email, role, invited })),
  })
})

// ----------------------------------------------------------------------------
// POST /api/x-agent/create - create a new agent (always reviewed, never remembered)
// ----------------------------------------------------------------------------

const createBodySchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  instructions: z.string().optional(),
})

xAgent.post('/create', zValidator('json', createBodySchema), async (c) => {
  const callerSlug = getCallerSlug(c)
  const body = c.req.valid('json')
  const policy = await checkAgentPolicy(callerSlug, 'create', null, body.name, body.name)
  if (!policy.allowed) {
    return c.json({ error: policy.reason ?? 'Forbidden' }, 403)
  }
  const agent = await createAgent({
    name: body.name,
    description: body.description,
    instructions: body.instructions,
  })

  // In auth mode, copy ACL from caller's owners so the new agent inherits them
  const owners = isAuthMode() ? await getOwnersOfAgent(callerSlug) : []
  const now = new Date()
  for (const userId of owners) {
    await db.insert(agentAcl).values({
      id: randomUUID(),
      userId,
      agentSlug: agent.slug,
      role: 'owner',
      createdAt: now,
    })
  }

  // Announce only after ACL inheritance, to each inherited owner, so their
  // live streams load their agents again and follow the new one.
  announceAgentCreated(agent.slug, owners)

  return c.json({ slug: agent.displaySlug, name: agent.name })
})

// ----------------------------------------------------------------------------
// POST /api/x-agent/get-sessions - list sessions of a target agent
// ----------------------------------------------------------------------------

const getSessionsBodySchema = z.object({
  slug: z.string(),
  limit: z.number().int().min(1).max(200).optional(),
  offset: z.number().int().min(0).optional(),
})

xAgent.post('/get-sessions', zValidator('json', getSessionsBodySchema), async (c) => {
  const { slug, limit = 50, offset = 0 } = c.req.valid('json')
  const result = await getTargetSessions(agentXAgentCaller(getCallerSlug(c)), { slug, limit, offset })
  if (!result.ok) return c.json({ error: result.error }, result.status)
  return c.json(result.value)
})

// ----------------------------------------------------------------------------
// POST /api/x-agent/get-transcript - read transcript for a target session
// ----------------------------------------------------------------------------

const getTranscriptBodySchema = z.object({
  slug: z.string(),
  sessionId: z.string(),
  sync: z.boolean().optional(),
  // Most recent N view-rows. Omitted = the whole view.
  limit: z.number().int().min(1).max(500).optional(),
  // Default quiet: spoken turns, internals collapsed. true = today's compact view.
  fullTranscript: z.boolean().optional(),
})

xAgent.post('/get-transcript', zValidator('json', getTranscriptBodySchema), async (c) => {
  const result = await getTargetTranscript(agentXAgentCaller(getCallerSlug(c)), c.req.valid('json'))
  if (!result.ok) return c.json({ error: result.error }, result.status)
  return c.json(result.value)
})

// ----------------------------------------------------------------------------
// POST /api/x-agent/download-file - stream a successful deliver_file output
// ----------------------------------------------------------------------------

function attachmentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}

xAgent.post('/download-file', zValidator('json', xAgentDownloadFileBodySchema), async (c) => {
  const result = await openDeliveredFile(agentXAgentCaller(getCallerSlug(c)), c.req.valid('json'))
  if (!result.ok) return c.json({ error: result.error }, result.status)
  const { body, sizeBytes, filename } = result.value
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(sizeBytes),
      'Content-Disposition': attachmentDisposition(filename),
      'Cache-Control': 'private, no-store, max-age=0',
    },
  })
})

// ----------------------------------------------------------------------------
// POST /api/x-agent/invoke - send prompt to a target agent (new or existing session)
// ----------------------------------------------------------------------------

const invokeBodySchema = z.object({
  slug: z.string().optional(),
  prompt: z.string().min(1),
  sessionId: z.string().optional(),
  sync: z.boolean().optional(),
  attachments: xAgentAttachmentsSchema.optional(),
  model: z.string().min(1).optional(),
  effort: z.enum(EFFORT_LEVELS).optional(),
  speed: z.enum(SPEED_LEVELS).optional(),
  // Cycle protection: container sends the calling Claude session ID so the host
  // can reject calls from sessions that were themselves invoked by an agent
  // (one-hop rule).
  _callerSessionId: z.string().optional(),
})

xAgent.post('/invoke', zValidator('json', invokeBodySchema), async (c) => {
  const { _callerSessionId, ...input } = c.req.valid('json')
  const result = await invokeAgent(agentXAgentCaller(getCallerSlug(c), _callerSessionId), {
    ...input,
    signal: c.req.raw.signal,
  })
  if (!result.ok) return c.json({ error: result.error }, result.status)
  return c.json(result.value)
})

export default xAgent
