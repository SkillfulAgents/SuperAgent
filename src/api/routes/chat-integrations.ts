/**
 * Chat Integrations API Routes
 *
 * CRUD endpoints for managing external chat integrations (Telegram, Slack).
 * Agent-scoped listing is in agents.ts under /api/agents/:id/chat-integrations.
 */

import { Hono } from 'hono'
import {
  getChatIntegration,
  createChatIntegration,
  updateChatIntegration,
  updateChatIntegrationStatus,
  deleteChatIntegration,
  DuplicateBotTokenError,
} from '@shared/lib/services/chat-integration-service'
import { listChatIntegrationSessions, archiveChatIntegrationSession, getChatIntegrationSessionById, deleteChatIntegrationSessionsByIntegration } from '@shared/lib/services/chat-integration-session-service'
import { chatIntegrationManager } from '@shared/lib/chat-integrations/chat-integration-manager'
import { validateChatIntegrationConfig } from '@shared/lib/chat-integrations/config-schema'
import { Authenticated, AgentUser, EntityAgentRole } from '../middleware/auth'
import { captureException } from '@shared/lib/error-reporting'

const SENTRY_TAGS = { component: 'chat-integration' } as const

const chatIntegrationsRouter = new Hono()

chatIntegrationsRouter.use('*', Authenticated())

const IntegrationAgentRole = EntityAgentRole({
  paramName: 'integrationId',
  lookupFn: async (id: string) => getChatIntegration(id),
  contextKey: 'chatIntegration',
  entityName: 'Chat integration',
})

// GET /api/chat-integrations/:integrationId - Get a single integration
chatIntegrationsRouter.get('/:integrationId', IntegrationAgentRole('viewer'), async (c) => {
  try {
    const integration = c.get('chatIntegration' as never)
    return c.json(integration)
  } catch (error) {
    console.error('Failed to fetch chat integration:', error)
    captureException(error, { tags: { ...SENTRY_TAGS, operation: 'get-integration' }, extra: { integrationId: c.req.param('integrationId') } })
    return c.json({ error: 'Failed to fetch chat integration' }, 500)
  }
})

// POST /api/chat-integrations - Create a new integration
// AgentUser validates the user has 'user' role on the agent identified by :id param
chatIntegrationsRouter.post('/:id', AgentUser(), async (c) => {
  try {
    const agentSlug = c.req.param('id')
    const body = await c.req.json()
    const { provider, name, config, showToolCalls } = body

    if (!provider || !config) {
      return c.json({ error: 'Missing required fields: provider, config' }, 400)
    }

    if (!['telegram', 'slack'].includes(provider)) {
      return c.json({ error: 'Invalid provider. Must be "telegram" or "slack"' }, 400)
    }

    // Validate config against Zod schema
    try {
      validateChatIntegrationConfig(provider, config)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invalid config'
      return c.json({ error: `Invalid config: ${message}` }, 400)
    }

    // Get the authenticated user ID if available
    const user = c.get('user' as never) as { id: string } | undefined
    const createdByUserId = user?.id

    let id: string
    try {
      id = createChatIntegration({
        agentSlug,
        provider,
        name,
        config,
        showToolCalls: showToolCalls ?? false,
        createdByUserId,
      })
    } catch (err) {
      if (err instanceof DuplicateBotTokenError) {
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

    // Start the integration
    try {
      await chatIntegrationManager.addIntegration(id)
    } catch (err) {
      // Integration was created but failed to connect — update status to error
      const errMsg = err instanceof Error ? err.message : String(err)
      console.error('Failed to connect new chat integration:', err)
      captureException(err, {
        tags: { ...SENTRY_TAGS, operation: 'create-integration-connect' },
        extra: { integrationId: id, agentSlug, provider },
      })
      updateChatIntegrationStatus(id, 'error', errMsg)
    }

    const integration = getChatIntegration(id)
    return c.json(integration, 201)
  } catch (error) {
    console.error('Failed to create chat integration:', error)
    captureException(error, { tags: { ...SENTRY_TAGS, operation: 'create-integration' }, extra: { agentSlug: c.req.param('id') } })
    return c.json({ error: 'Failed to create chat integration' }, 500)
  }
})

// PATCH /api/chat-integrations/:integrationId - Update an integration
chatIntegrationsRouter.patch('/:integrationId', IntegrationAgentRole('user'), async (c) => {
  try {
    const id = c.req.param('integrationId')
    const body = await c.req.json()
    const { name, config, showToolCalls, status } = body

    // Validate config if provided
    if (config !== undefined) {
      const integration = c.get('chatIntegration' as never) as Awaited<ReturnType<typeof getChatIntegration>>
      if (integration) {
        try {
          validateChatIntegrationConfig(integration.provider as 'telegram' | 'slack', config)
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Invalid config'
          return c.json({ error: `Invalid config: ${message}` }, 400)
        }
      }
    }

    // Step 1: Persist DB updates first (config, name, showToolCalls)
    const updates: Record<string, unknown> = {}
    if (name !== undefined) updates.name = name
    if (config !== undefined) updates.config = config
    if (showToolCalls !== undefined) updates.showToolCalls = showToolCalls

    if (Object.keys(updates).length > 0) {
      updateChatIntegration(id, updates)
    }

    // Step 2: Handle lifecycle changes (pause/resume/reconnect)
    if (status === 'paused') {
      await chatIntegrationManager.pauseIntegration(id)
    } else if (status === 'active') {
      await chatIntegrationManager.resumeIntegration(id)
    } else if (config !== undefined && status !== 'paused') {
      // Config changed while active — reconnect to pick up new credentials
      await chatIntegrationManager.removeIntegration(id)
      await chatIntegrationManager.addIntegration(id)
    }

    const updated = getChatIntegration(id)
    return c.json(updated)
  } catch (error) {
    if (error instanceof DuplicateBotTokenError) {
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
    console.error('Failed to update chat integration:', error)
    captureException(error, { tags: { ...SENTRY_TAGS, operation: 'update-integration' }, extra: { integrationId: c.req.param('integrationId') } })
    return c.json({ error: 'Failed to update chat integration' }, 500)
  }
})

// DELETE /api/chat-integrations/:integrationId - Delete an integration
chatIntegrationsRouter.delete('/:integrationId', IntegrationAgentRole('user'), async (c) => {
  try {
    const id = c.req.param('integrationId')

    // Disconnect first
    await chatIntegrationManager.removeIntegration(id)

    // Clean up session mappings
    deleteChatIntegrationSessionsByIntegration(id)

    const deleted = deleteChatIntegration(id)
    if (!deleted) {
      return c.json({ error: 'Chat integration not found' }, 404)
    }

    return c.body(null, 204)
  } catch (error) {
    console.error('Failed to delete chat integration:', error)
    captureException(error, { tags: { ...SENTRY_TAGS, operation: 'delete-integration' }, extra: { integrationId: c.req.param('integrationId') } })
    return c.json({ error: 'Failed to delete chat integration' }, 500)
  }
})

// POST /api/chat-integrations/:integrationId/test - Test credentials without saving
chatIntegrationsRouter.post('/:integrationId/test', IntegrationAgentRole('user'), async (c) => {
  try {
    const integration = c.get('chatIntegration' as never) as Awaited<ReturnType<typeof getChatIntegration>>
    if (!integration) {
      return c.json({ error: 'Chat integration not found' }, 404)
    }

    // Test by attempting to connect and immediately disconnect
    const isConnected = chatIntegrationManager.isIntegrationConnected(integration.id)
    return c.json({ connected: isConnected, provider: integration.provider })
  } catch (error) {
    console.error('Failed to test chat integration:', error)
    captureException(error, { tags: { ...SENTRY_TAGS, operation: 'test-integration' }, extra: { integrationId: c.req.param('integrationId') } })
    return c.json({ error: 'Failed to test chat integration' }, 500)
  }
})

// GET /api/chat-integrations/:integrationId/status - Connection health
chatIntegrationsRouter.get('/:integrationId/status', IntegrationAgentRole('viewer'), async (c) => {
  try {
    const integration = c.get('chatIntegration' as never) as Awaited<ReturnType<typeof getChatIntegration>>
    if (!integration) {
      return c.json({ error: 'Chat integration not found' }, 404)
    }

    const connected = chatIntegrationManager.isIntegrationConnected(integration.id)
    return c.json({
      status: integration.status,
      connected,
      provider: integration.provider,
    })
  } catch (error) {
    console.error('Failed to get chat integration status:', error)
    captureException(error, { tags: { ...SENTRY_TAGS, operation: 'get-status' }, extra: { integrationId: c.req.param('integrationId') } })
    return c.json({ error: 'Failed to get status' }, 500)
  }
})

// GET /api/chat-integrations/:integrationId/sessions - List chat sessions for an integration
chatIntegrationsRouter.get('/:integrationId/sessions', IntegrationAgentRole('viewer'), async (c) => {
  try {
    const id = c.req.param('integrationId')
    const sessions = listChatIntegrationSessions(id)
    return c.json(sessions)
  } catch (error) {
    console.error('Failed to list chat integration sessions:', error)
    captureException(error, { tags: { ...SENTRY_TAGS, operation: 'list-sessions' }, extra: { integrationId: c.req.param('integrationId') } })
    return c.json({ error: 'Failed to list sessions' }, 500)
  }
})

// DELETE /api/chat-integrations/:integrationId/sessions/:sessionId - Clear a chat session
chatIntegrationsRouter.delete('/:integrationId/sessions/:sessionId', IntegrationAgentRole('user'), async (c) => {
  try {
    const sessionId = c.req.param('sessionId')
    const session = getChatIntegrationSessionById(sessionId)
    if (!session) {
      return c.json({ error: 'Session not found' }, 404)
    }
    // Notify the manager to clean up SSE subscriptions
    chatIntegrationManager.clearChatSessionById(sessionId)

    // Archive the session mapping (keeps it visible in sidebar as archived)
    archiveChatIntegrationSession(sessionId)
    return c.json({ success: true })
  } catch (error) {
    console.error('Failed to clear chat session:', error)
    captureException(error, { tags: { ...SENTRY_TAGS, operation: 'clear-session' }, extra: { integrationId: c.req.param('integrationId'), sessionId: c.req.param('sessionId') } })
    return c.json({ error: 'Failed to clear session' }, 500)
  }
})

// POST /api/chat-integrations/test-credentials - Test credentials before creating
chatIntegrationsRouter.post('/test-credentials', Authenticated(), async (c) => {
  try {
    const body = await c.req.json()
    const { provider, config } = body

    if (!provider || !config) {
      return c.json({ error: 'Missing required fields: provider, config' }, 400)
    }

    // Validate by attempting a lightweight API call
    if (provider === 'telegram') {
      const botToken = config.botToken
      if (!botToken) {
        return c.json({ error: 'Missing botToken' }, 400)
      }
      // Call Telegram getMe to validate
      const res = await fetch(`https://api.telegram.org/bot${botToken}/getMe`)
      const data = await res.json() as { ok: boolean; result?: { username: string; first_name: string } }
      if (!data.ok) {
        return c.json({ valid: false, error: 'Invalid bot token' }, 400)
      }
      return c.json({ valid: true, botName: data.result?.first_name, botUsername: data.result?.username })
    }

    if (provider === 'slack') {
      const botToken = config.botToken
      const appToken = config.appToken
      if (!botToken) {
        return c.json({ error: 'Missing botToken' }, 400)
      }
      if (!appToken) {
        return c.json({ error: 'Missing appToken (app-level token for Socket Mode)' }, 400)
      }
      // Validate bot token via auth.test
      const res = await fetch('https://slack.com/api/auth.test', {
        headers: { 'Authorization': `Bearer ${botToken}` },
      })
      const data = await res.json() as { ok: boolean; team?: string; user?: string; error?: string }
      if (!data.ok) {
        return c.json({ valid: false, error: `Bot token invalid: ${data.error || 'unknown error'}` }, 400)
      }
      // Validate app token via apps.connections.open (proves Socket Mode will work)
      const socketRes = await fetch('https://slack.com/api/apps.connections.open', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${appToken}` },
      })
      const socketData = await socketRes.json() as { ok: boolean; error?: string }
      if (!socketData.ok) {
        return c.json({ valid: false, error: `App token invalid: ${socketData.error || 'unknown error'}. Ensure Socket Mode is enabled and the token has connections:write scope.` }, 400)
      }
      return c.json({ valid: true, team: data.team, user: data.user })
    }

    return c.json({ error: 'Invalid provider' }, 400)
  } catch (error) {
    console.error('Failed to test credentials:', error)
    captureException(error, { tags: { ...SENTRY_TAGS, operation: 'test-credentials' } })
    return c.json({ error: 'Failed to test credentials' }, 500)
  }
})

export default chatIntegrationsRouter
