/**
 * Shared Agent Integration CRUD Routes
 *
 * Shared management endpoints for all external integrations.
 * Mounted at /api/agent-integrations with /api/chat-integrations as a legacy alias.
 */

import { Hono, type MiddlewareHandler, type Context } from 'hono'
import { z } from 'zod'
import {
  getAgentIntegration,
  createAgentIntegration,
  updateAgentIntegration,
  updateAgentIntegrationStatus,
  deleteAgentIntegration,
  DuplicateIntegrationIdentityError,
  IntegrationConfigurationUnsupportedError,
} from '@shared/lib/services/agent-integration-service'
import {
  getChatAccessById,
  listChatAccess,
  approveChatAccess,
  denyChatAccess,
  revokeChatAccess,
} from '@shared/lib/services/chat-integration-access-service'
import type { ChatAccessStatus } from '@shared/lib/services/chat-integration-access-service'
import { listAgentIntegrationSessions, archiveAgentIntegrationSession, getAgentIntegrationSessionById, deleteAgentIntegrationSessionsByIntegration } from '@shared/lib/services/agent-integration-session-service'
import { agentIntegrationManager } from '@shared/lib/agent-integrations/agent-integration-manager'
import { cleanupIntegrationResource } from '@shared/lib/agent-integrations/cleanup'
import { listAgentIntegrationsHandler } from './agent-integration-list'
import { getIntegrationSetup, integrationSetupContext, prepareIntegrationSetup, testIntegrationCredentials, setupError } from '@shared/lib/agent-integrations/setup'
import { integrationSetupQuerySchema, integrationSetupMetadataSchema } from '@shared/lib/agent-integrations/setup-schema'
import { toPublicAgentIntegration, publicIntegrationStatus } from '@shared/lib/agent-integrations/serialization'
import { agentIntegrationRegistry } from '@shared/lib/agent-integrations/registry'
import { getCurrentUserId } from '@shared/lib/auth/config'
import { logAuditEvent } from '@shared/lib/services/audit-log-service'
import { Authenticated, AgentRead, AgentUser, AgentAdmin, EntityAgentRole, ResolveAgent, getAgentId, getAuthorizedAgentRole, hasMinRole } from '../middleware/auth'
import { captureException } from '@shared/lib/error-reporting'
import { SPEED_LEVELS } from '@shared/lib/container/types'

const SENTRY_TAGS = { component: 'agent-integration' } as const

// Speed override carried on create/update bodies: a level, null to clear, or absent.
const speedOverrideSchema = z.enum(SPEED_LEVELS).nullable().optional()

const agentIntegrationsRouter = new Hono()

async function completeAuthorization(c: Context) {
  c.header('Cache-Control', 'no-store'); c.header('Referrer-Policy', 'no-referrer')
  try {
    const callback = getIntegrationSetup(c.req.param('provider') ?? '').callback
    const state = c.req.query('state')
    if (!callback || !state) return c.html('<h1>Authorization unavailable</h1><p>Return to Gamut to try again.</p>', 400)
    const result = await callback({ state, code: c.req.query('code'), error: c.req.query('error') })
    if (result.cancelled || !result.integrationId) return c.html('<h1>Authorization cancelled</h1><p>Return to Gamut to try again.</p>', 400)
    const installed = await getAgentIntegration(result.integrationId)
    if (installed?.provider !== c.req.param('provider')) throw new Error('Authorization belongs to another provider')
    try { await agentIntegrationManager.resumeIntegration(result.integrationId) }
    catch (error) {
      captureException(error, { tags: { component: 'agent-integration', operation: 'initial-connect' } })
      return c.html('<h1>Account authorized</h1><p>Event delivery is temporarily unavailable and will retry automatically. You can close this window and return to Gamut.</p>')
    }
    return c.html('<h1>Account connected</h1><p>You can close this window and return to Gamut.</p>')
  } catch (error) {
    if (!setupError(error)) captureException(error, { tags: { component: 'agent-integration', operation: 'authorization-callback' } })
    return c.html('<h1>Could not authorize account</h1><p>Return to Gamut and check the app credentials, workspace and permissions.</p>', 400)
  }
}
agentIntegrationsRouter.get('/providers/:provider/callback', completeAuthorization)
// Existing installed apps may retain this shorter callback URL.
agentIntegrationsRouter.get('/:provider/callback', async (c, next) => {
  const provider = c.req.param('provider')
  // Only actual callback providers own this alias; /agents/callback is a list URL.
  if (!agentIntegrationRegistry.getDefinition(provider) || !agentIntegrationRegistry.getProvider(provider).setup?.callback) return next()
  return completeAuthorization(c)
})
agentIntegrationsRouter.use('*', Authenticated())
agentIntegrationsRouter.get('/agents/:id', ResolveAgent(), AgentRead(), listAgentIntegrationsHandler)

const IntegrationAgentRole = EntityAgentRole({
  paramName: 'integrationId',
  lookupFn: async (id: string) => getAgentIntegration(id),
  contextKey: 'agentIntegration',
  entityName: 'Agent integration',
})

// Chat management permits agent users; private OAuth app management needs an owner.
// Run after the entity authorization so the common case uses its already-loaded row.
const RequireProviderManagement: MiddlewareHandler = async (c, next) => {
  const row = c.get('agentIntegration' as never) as NonNullable<Awaited<ReturnType<typeof getAgentIntegration>>>
  const role = agentIntegrationRegistry.getDefinition(row.provider)?.managementAccess ?? 'owner'
  const authorizedRole = getAuthorizedAgentRole(c)
  if (!authorizedRole || !hasMinRole(authorizedRole, role)) return c.json({ error: 'Forbidden' }, 403)
  return next()
}

// GET /api/agent-integrations/:integrationId - Get a single integration
agentIntegrationsRouter.get('/:integrationId', IntegrationAgentRole('viewer'), async (c) => {
  try {
    const integration = c.get('agentIntegration' as never) as NonNullable<Awaited<ReturnType<typeof getAgentIntegration>>>
    return c.json(toPublicAgentIntegration(integration))
  } catch (error) {
    console.error('Failed to fetch agent integration:', error)
    captureException(error, { tags: { ...SENTRY_TAGS, operation: 'get-integration' }, extra: { integrationId: c.req.param('integrationId') } })
    return c.json({ error: 'Failed to fetch agent integration' }, 500)
  }
})

// Owner review is separate from agent tools; release rechecks current admission policy.
agentIntegrationsRouter.get('/:integrationId/email-held', IntegrationAgentRole('owner'), async c => {
  const integration = c.get('agentIntegration' as never) as NonNullable<Awaited<ReturnType<typeof getAgentIntegration>>>
  if (integration.provider !== 'platform-email') return c.json({ error: 'Not an email integration' }, 400)
  const { heldEmails } = await import('@shared/lib/email-integrations/review')
  return c.json({ data: await heldEmails(integration.id) })
})
agentIntegrationsRouter.post('/:integrationId/email-held/:messageId/release', IntegrationAgentRole('owner'), async c => {
  const integration = c.get('agentIntegration' as never) as NonNullable<Awaited<ReturnType<typeof getAgentIntegration>>>
  if (integration.provider !== 'platform-email' || integration.status !== 'active') return c.json({ error: 'Email integration must be active' }, 409)
  const connector = agentIntegrationManager.getConnector(integration.id)
  const { EmailAgentIntegration } = await import('@shared/lib/email-integrations/email-agent-integration')
  if (!(connector instanceof EmailAgentIntegration)) return c.json({ error: 'Email integration is not connected' }, 409)
  await connector.releaseHeld(c.req.param('messageId'))
  await logAuditEvent({ userId: getCurrentUserId(c), object: 'chat_integration', objectId: integration.id, action: 'updated', details: { releasedEmailId: c.req.param('messageId') } })
  return c.json({ queued: true }, 202)
})

// POST /api/agent-integrations/test-credentials - Test credentials before creating
// NOTE: must be declared before `POST /:id` — Hono matches routes in declaration
// order, so a parameterized `/:id` would otherwise shadow this static path.
agentIntegrationsRouter.post('/test-credentials', Authenticated(), async (c) => {
  try {
    const body = await c.req.json()
    const { provider, config } = body

    if (!provider || !config) {
      return c.json({ error: 'Missing required fields: provider, config' }, 400)
    }

    return c.json(await testIntegrationCredentials(provider, config))
  } catch (error) {
    const failure = setupError(error)
    if (failure) return c.json({ valid: false, error: failure.error }, failure.status)
    console.error('Failed to test credentials:', error)
    captureException(error, { tags: { ...SENTRY_TAGS, operation: 'test-credentials' } })
    return c.json({ error: 'Failed to test credentials' }, 500)
  }
})

// POST /api/agent-integrations - Create a new integration
// ResolveAgent maps the :id route param (which may be a display slug) to the
// canonical id BEFORE AgentUser checks the ACL — otherwise auth mode denies valid
// owners (ACL is id-keyed) and non-auth mode persists the display slug, splitting
// the row from the canonical id. AgentUser then validates the 'user' role.
const RequireSetupManagement: MiddlewareHandler = async (c, next) => {
  const provider = c.req.param('provider') ?? (await c.req.json()).provider
  const definition = agentIntegrationRegistry.getDefinition(provider)
  if (!definition) return c.json({ error: 'Unknown integration provider' }, 400)
  return (definition.managementAccess ?? 'owner') === 'owner' ? AgentAdmin()(c, next) : AgentUser()(c, next)
}
// Read setup links before creating an installation, using the same management ACL.
agentIntegrationsRouter.get('/agents/:id/providers/:provider/setup', ResolveAgent(), RequireSetupManagement, async c => {
  c.header('Cache-Control', 'no-store')
  try {
    const provider = c.req.param('provider')
    const { name } = integrationSetupQuerySchema.parse(c.req.query())
    const context = integrationSetupContext(provider, c.req.raw, getAgentId(c), getCurrentUserId(c))
    const metadata = await getIntegrationSetup(provider).describe?.(context, name) ?? {}
    return c.json(integrationSetupMetadataSchema.parse(metadata))
  } catch (error) {
    const failure = setupError(error)
    if (failure) return c.json({ error: failure.error }, failure.status)
    captureException(error, { tags: { ...SENTRY_TAGS, operation: 'describe-setup' } })
    return c.json({ error: 'Could not load integration setup' }, 500)
  }
})
agentIntegrationsRouter.post('/agents/:id', ResolveAgent(), RequireSetupManagement, createIntegration)
agentIntegrationsRouter.post('/:id', ResolveAgent(), RequireSetupManagement, createIntegration)
async function createIntegration(c: Parameters<MiddlewareHandler>[0]) {
  try {
    const agentSlug = getAgentId(c)
    const body = await c.req.json()
    const { provider, name, config, showToolCalls, sessionTimeout, model, effort } = body
    const parsedSpeed = speedOverrideSchema.safeParse(body.speed)
    if (!parsedSpeed.success) {
      return c.json({ error: `Invalid speed. Must be one of: ${SPEED_LEVELS.join(', ')}` }, 400)
    }
    // requireApproval is intentionally NOT accepted here: making a bot public is
    // owner-only and must go through PATCH /:integrationId/require-approval. New
    // integrations default to requireApproval=true (private).

    if (!provider || !config) {
      return c.json({ error: 'Missing required fields: provider, config' }, 400)
    }

    const prepared = await prepareIntegrationSetup(provider, config, integrationSetupContext(provider, c.req.raw, agentSlug, getCurrentUserId(c)))

    // Get the authenticated user ID if available
    const user = c.get('user' as never) as { id: string } | undefined
    const createdByUserId = user?.id

    let id: string
    try {
      id = await createAgentIntegration({
        agentSlug,
        provider,
        name,
        config: prepared.config,
        status: prepared.status,
        showToolCalls: showToolCalls ?? false,
        sessionTimeout: sessionTimeout ?? null,
        model: model ?? null,
        effort: effort ?? null,
        speed: parsedSpeed.data ?? null,
        createdByUserId,
      })
    } catch (err) {
      if (err instanceof DuplicateIntegrationIdentityError) {
        // User-facing conflict — capture at `warning` level so we can track frequency
        // but it doesn't page anyone as an error.
        captureException(err, {
          tags: { ...SENTRY_TAGS, operation: 'create-integration-duplicate' },
          level: 'warning',
          extra: { agentSlug, provider, existingIntegrationId: err.existingIntegrationId },
        })
        return c.json(
          { error: err.message, code: 'duplicate_bot_token', existingIntegrationId: err.existingIntegrationId },
          409,
        )
      }
      throw err
    }

    // Providers may require authorization before their runtime can connect.
    try {
      if (!prepared.status || prepared.status === 'active') await agentIntegrationManager.addIntegration(id)
    } catch (err) {
      // Integration was created but failed to connect — update status to error
      const errMsg = err instanceof Error ? err.message : String(err)
      console.error('Failed to connect new agent integration:', err)
      captureException(err, {
        tags: { ...SENTRY_TAGS, operation: 'create-integration-connect' },
        extra: { integrationId: id, agentSlug, provider },
      })
      await updateAgentIntegrationStatus(id, 'error', errMsg)
    }

    // Outside the connect try/catch: a contact-card failure is cosmetic and must
    // never surface as a connect error. Not awaited either — the upload has its
    // own 30s timeout and setup must not block on it.
    void agentIntegrationManager.integrationCreated(id)

    const integration = await getAgentIntegration(id)
    if (!integration) throw new Error('Agent integration disappeared after creation')
    await logAuditEvent({ userId: getCurrentUserId(c), object: 'chat_integration', objectId: id, action: 'created', details: { provider, agentSlug } })
    return c.json(toPublicAgentIntegration(integration), 201)
  } catch (error) {
    const failure = setupError(error)
    if (failure) return c.json({ error: failure.error }, failure.status)
    console.error('Failed to create agent integration:', error)
    captureException(error, { tags: { ...SENTRY_TAGS, operation: 'create-integration' }, extra: { agentSlug: c.req.param('id') } })
    return c.json({ error: 'Failed to create agent integration' }, 500)
  }
}

agentIntegrationsRouter.post('/:integrationId/authorize', IntegrationAgentRole('user'), RequireProviderManagement, async c => {
  const row = c.get('agentIntegration' as never) as NonNullable<Awaited<ReturnType<typeof getAgentIntegration>>>
  try {
    const authorization = getIntegrationSetup(row.provider).authorize
    if (!authorization) return c.json({ error: 'This provider does not use external authorization' }, 400)
    const input = authorization.inputSchema.parse(await c.req.json())
    const result = await authorization.run(row, input, integrationSetupContext(row.provider, c.req.raw, row.agentSlug, getCurrentUserId(c)))
    // Validation, credential lookup and attempt persistence may fail. Keep the
    // current account running until the provider has a usable authorization URL.
    await agentIntegrationManager.pauseIntegration(row.id)
    return c.json(result)
  } catch (error) {
    const failure = setupError(error)
    if (failure) return c.json({ error: failure.error }, failure.status)
    captureException(error, { tags: { component: 'agent-integration', operation: 'authorize' } })
    return c.json({ error: 'Could not authorize integration' }, 500)
  }
})

// PATCH /api/agent-integrations/:integrationId - Update an integration
agentIntegrationsRouter.patch('/:integrationId', IntegrationAgentRole('user'), RequireProviderManagement, async (c) => {
  try {
    const id = c.req.param('integrationId')
    const body = await c.req.json()
    const { name, config, showToolCalls, sessionTimeout, model, effort, status } = body
    const parsedSpeed = speedOverrideSchema.safeParse(body.speed)
    if (!parsedSpeed.success) {
      return c.json({ error: `Invalid speed. Must be one of: ${SPEED_LEVELS.join(', ')}` }, 400)
    }

    const integration = c.get('agentIntegration' as never) as NonNullable<Awaited<ReturnType<typeof getAgentIntegration>>>
    await agentIntegrationRegistry.getProvider(integration.provider).updateSettings?.(integration, body)

    // Step 1: Persist DB updates first (config, name, showToolCalls)
    const updates: Record<string, unknown> = {}
    if (name !== undefined) updates.name = name
    if (config !== undefined) updates.config = config
    if (showToolCalls !== undefined) updates.showToolCalls = showToolCalls
    if (sessionTimeout !== undefined) updates.sessionTimeout = sessionTimeout
    if (model !== undefined) updates.model = model
    if (effort !== undefined) updates.effort = effort
    if (body.speed !== undefined) updates.speed = parsedSpeed.data ?? null

    if (Object.keys(updates).length > 0) {
      if (!(await updateAgentIntegration(id, updates))) {
        throw new Error('Agent integration disappeared during update')
      }
    }

    // Step 2: Handle lifecycle changes (pause/resume/reconnect)
    if (status === 'paused') {
      await agentIntegrationManager.pauseIntegration(id)
    } else if (status === 'active') {
      await agentIntegrationManager.resumeIntegration(id)
    } else if (config !== undefined && status !== 'paused') {
      // Config changed while active — reconnect to pick up new credentials
      await agentIntegrationManager.removeIntegration(id)
      if (integration.status !== 'paused') await agentIntegrationManager.addIntegration(id)
    }

    const updated = await getAgentIntegration(id)
    if (!updated) throw new Error('Agent integration disappeared after update')
    await logAuditEvent({ userId: getCurrentUserId(c), object: 'chat_integration', objectId: id, action: 'updated' })
    return c.json(toPublicAgentIntegration(updated))
  } catch (error) {
    if (error instanceof DuplicateIntegrationIdentityError) {
      captureException(error, {
        tags: { ...SENTRY_TAGS, operation: 'update-integration-duplicate' },
        level: 'warning',
        extra: { integrationId: c.req.param('integrationId'), existingIntegrationId: error.existingIntegrationId },
      })
      return c.json(
        { error: error.message, code: 'duplicate_bot_token', existingIntegrationId: error.existingIntegrationId },
        409,
      )
    }
    if (error instanceof IntegrationConfigurationUnsupportedError) return c.json({ error: error.message }, 400)
    if (error instanceof z.ZodError) {
      const message = error.issues[0]?.message ?? 'Invalid config'
      return c.json({ error: `Invalid config: ${message}` }, 400)
    }
    const failure = setupError(error)
    if (failure) return c.json({ error: failure.error }, failure.status)
    console.error('Failed to update agent integration:', error)
    captureException(error, { tags: { ...SENTRY_TAGS, operation: 'update-integration' }, extra: { integrationId: c.req.param('integrationId') } })
    return c.json({ error: 'Failed to update agent integration' }, 500)
  }
})

// PATCH /api/agent-integrations/:integrationId/require-approval - Toggle the allowlist (owner-only)
// Separate from the general PATCH so the security-sensitive "make public" flip requires
// the owner role, and so turning approval ON can reconcile already-running sessions.
agentIntegrationsRouter.patch('/:integrationId/require-approval', IntegrationAgentRole('owner'), async (c) => {
  try {
    const id = c.req.param('integrationId')
    const { requireApproval } = await c.req.json()
    if (!z.boolean().safeParse(requireApproval).success) {
      return c.json({ error: 'requireApproval must be a boolean' }, 400)
    }
    if (!(await updateAgentIntegration(id, { requireApproval }))) {
      throw new Error('Agent integration disappeared during approval update')
    }
    // Secure-by-default: enabling approval must gate already-running sessions whose
    // chat is not explicitly allowed (previously-public conversations).
    if (requireApproval === true) {
      await agentIntegrationManager.reconcileAccess(id)
    }
    const updated = await getAgentIntegration(id)
    if (!updated) throw new Error('Agent integration disappeared after approval update')
    await logAuditEvent({ userId: getCurrentUserId(c), object: 'chat_integration', objectId: id, action: 'updated', details: { requireApproval } })
    return c.json(toPublicAgentIntegration(updated))
  } catch (error) {
    captureException(error, { tags: { ...SENTRY_TAGS, operation: 'set-require-approval' }, extra: { integrationId: c.req.param('integrationId') } })
    return c.json({ error: 'Failed to update require approval' }, 500)
  }
})

// DELETE /api/agent-integrations/:integrationId - Delete an integration
agentIntegrationsRouter.delete('/:integrationId', IntegrationAgentRole('user'), RequireProviderManagement, async (c) => {
  try {
    const id = c.req.param('integrationId')

    const integration = c.get('agentIntegration' as never) as NonNullable<Awaited<ReturnType<typeof getAgentIntegration>>>
    await cleanupIntegrationResource(integration)

    // Clean up session mappings
    await deleteAgentIntegrationSessionsByIntegration(id)

    const deleted = await deleteAgentIntegration(id)
    if (!deleted) {
      return c.json({ error: 'Agent integration not found' }, 404)
    }

    await logAuditEvent({ userId: getCurrentUserId(c), object: 'chat_integration', objectId: id, action: 'deleted' })

    return c.body(null, 204)
  } catch (error) {
    console.error('Failed to delete agent integration:', error)
    captureException(error, { tags: { ...SENTRY_TAGS, operation: 'delete-integration' }, extra: { integrationId: c.req.param('integrationId') } })
    return c.json({ error: 'Failed to delete agent integration' }, 500)
  }
})

// POST /api/agent-integrations/:integrationId/test - Test credentials without saving
agentIntegrationsRouter.post('/:integrationId/test', IntegrationAgentRole('user'), RequireProviderManagement, async (c) => {
  try {
    const integration = c.get('agentIntegration' as never) as Awaited<ReturnType<typeof getAgentIntegration>>
    if (!integration) {
      return c.json({ error: 'Agent integration not found' }, 404)
    }

    // Test by attempting to connect and immediately disconnect
    const isConnected = agentIntegrationManager.isIntegrationConnected(integration.id)
    return c.json({ connected: isConnected, provider: integration.provider })
  } catch (error) {
    console.error('Failed to test agent integration:', error)
    captureException(error, { tags: { ...SENTRY_TAGS, operation: 'test-integration' }, extra: { integrationId: c.req.param('integrationId') } })
    return c.json({ error: 'Failed to test agent integration' }, 500)
  }
})

// GET /api/agent-integrations/:integrationId/status - Connection health
agentIntegrationsRouter.get('/:integrationId/status', IntegrationAgentRole('viewer'), async (c) => {
  try {
    const integration = c.get('agentIntegration' as never) as Awaited<ReturnType<typeof getAgentIntegration>>
    if (!integration) {
      return c.json({ error: 'Agent integration not found' }, 404)
    }

    const connected = agentIntegrationManager.isIntegrationConnected(integration.id)
    return c.json({
      status: publicIntegrationStatus(integration),
      connected,
      provider: integration.provider,
    })
  } catch (error) {
    console.error('Failed to get agent integration status:', error)
    captureException(error, { tags: { ...SENTRY_TAGS, operation: 'get-status' }, extra: { integrationId: c.req.param('integrationId') } })
    return c.json({ error: 'Failed to get status' }, 500)
  }
})

// GET /api/agent-integrations/:integrationId/sessions - List chat sessions for an integration
agentIntegrationsRouter.get('/:integrationId/sessions', IntegrationAgentRole('viewer'), async (c) => {
  try {
    const id = c.req.param('integrationId')
    const sessions = await listAgentIntegrationSessions(id)
    return c.json(sessions)
  } catch (error) {
    console.error('Failed to list agent integration sessions:', error)
    captureException(error, { tags: { ...SENTRY_TAGS, operation: 'list-sessions' }, extra: { integrationId: c.req.param('integrationId') } })
    return c.json({ error: 'Failed to list sessions' }, 500)
  }
})

// DELETE /api/agent-integrations/:integrationId/sessions/:sessionId - Clear a chat session
agentIntegrationsRouter.delete('/:integrationId/sessions/:sessionId', IntegrationAgentRole('user'), RequireProviderManagement, async (c) => {
  try {
    const integrationId = c.req.param('integrationId')
    const sessionId = c.req.param('sessionId')
    const session = await getAgentIntegrationSessionById(sessionId)
    // Scope the session to the authorized integration. `IntegrationAgentRole`
    // only authorizes :integrationId; the session is loaded by primary key, so
    // we must verify it belongs to that integration before mutating it.
    // Otherwise a user with access to one integration could clear/archive a
    // session belonging to another integration/agent (BOLA — SUP-202/SUP-229).
    // Return 404 (not 403) so foreign session IDs are not enumerable.
    if (!session || session.integrationId !== integrationId) {
      return c.json({ error: 'Session not found' }, 404)
    }
    const integration = c.get('agentIntegration' as never) as NonNullable<Awaited<ReturnType<typeof getAgentIntegration>>>
    if (!agentIntegrationRegistry.getDefinition(integration.provider)?.managementCapabilities?.includes('reset_conversation')) {
      return c.json({ error: 'This integration keeps one session per work item' }, 400)
    }
    // Notify the manager to clean up SSE subscriptions
    await agentIntegrationManager.clearSessionById(sessionId)

    // Archive the session mapping (keeps it visible in sidebar as archived)
    await archiveAgentIntegrationSession(sessionId)
    return c.json({ success: true })
  } catch (error) {
    console.error('Failed to clear chat session:', error)
    captureException(error, { tags: { ...SENTRY_TAGS, operation: 'clear-session' }, extra: { integrationId: c.req.param('integrationId'), sessionId: c.req.param('sessionId') } })
    return c.json({ error: 'Failed to clear session' }, 500)
  }
})

// ── Access management routes ────────────────────────────────────────────

const accessStatusSchema = z.enum(['pending', 'allowed', 'denied'])

// GET /api/agent-integrations/:integrationId/access - List access entries (optionally filtered by status)
// Owner-only: entries expose requester identity + message previews, shown only to owners in the UI.
agentIntegrationsRouter.get('/:integrationId/access', IntegrationAgentRole('owner'), async (c) => {
  try {
    const integrationId = c.req.param('integrationId')
    const raw = c.req.query('status')
    let status: ChatAccessStatus | undefined
    if (raw !== undefined) {
      const parsed = accessStatusSchema.safeParse(raw)
      if (!parsed.success) return c.json({ error: 'Invalid status' }, 400)
      status = parsed.data
    }
    return c.json(await listChatAccess(integrationId, status))
  } catch (error) {
    captureException(error, { tags: { ...SENTRY_TAGS, operation: 'list-access' } })
    return c.json({ error: 'Failed to list access' }, 500)
  }
})

// POST /api/agent-integrations/:integrationId/access/:accessId/{approve,deny,revoke}
const accessActions = { approve: approveChatAccess, deny: denyChatAccess, revoke: revokeChatAccess } as const
for (const verb of ['approve', 'deny', 'revoke'] as const) {
  agentIntegrationsRouter.post(`/:integrationId/access/:accessId/${verb}`, IntegrationAgentRole('owner'), async (c) => {
    try {
      const integrationId = c.req.param('integrationId')
      const accessId = c.req.param('accessId')
      const row = await getChatAccessById(accessId)
      // BOLA guard: scope the access row to the authorized integration.
      // IntegrationAgentRole authorizes :integrationId only; the access row is
      // loaded by primary key, so we must verify it belongs to that integration.
      // Return 404 so foreign access IDs are not enumerable (SUP-229 pattern).
      if (!row || row.integrationId !== integrationId) return c.json({ error: 'Access entry not found' }, 404)
      const ok = await accessActions[verb](accessId, getCurrentUserId(c))
      if (ok) {
        await logAuditEvent({ userId: getCurrentUserId(c), object: 'chat_integration', objectId: integrationId, action: 'updated', details: { access: verb, accessId } })
        if (verb === 'approve') void agentIntegrationManager.notifyAccessApproved(integrationId, row.externalChatId)
        if (verb === 'revoke' || verb === 'deny') await agentIntegrationManager.releaseExternalSession(integrationId, row.externalChatId)
      }
      return c.json({ ok })
    } catch (error) {
      captureException(error, { tags: { ...SENTRY_TAGS, operation: `access-${verb}` } })
      return c.json({ error: `Failed to ${verb}` }, 500)
    }
  })
}

export default agentIntegrationsRouter
