import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { randomUUID } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { containerManager } from '@shared/lib/container/container-manager'
import { validateProxyToken } from '@shared/lib/proxy/token-store'
import {
  getChatIntegration,
  createChatIntegration,
  listChatIntegrations,
  updateChatIntegrationStatus,
  DuplicateBotTokenError,
} from '@shared/lib/services/chat-integration-service'
import {
  listChatIntegrationSessions,
} from '@shared/lib/services/chat-integration-session-service'
import { chatIntegrationManager } from '@shared/lib/chat-integrations/chat-integration-manager'
import type { DashboardDelivery } from '@shared/lib/chat-integrations/telegram-connector'
import {
  validateChatIntegrationConfig,
  CHAT_PROVIDERS,
  IMESSAGE_GATEWAY_URL,
  imessageSetupSchema,
  type ChatProvider,
} from '@shared/lib/chat-integrations/config-schema'
import { getSessionJsonlPath } from '@shared/lib/utils/file-storage'
import { captureException } from '@shared/lib/error-reporting'
import { isChatAllowed } from '@shared/lib/services/chat-integration-access-service'
import { listArtifactsFromFilesystem } from '@shared/lib/services/artifact-service'
import { shareDashboardRequestSchema } from './x-agent-chat-schema'

type XAgentChatVariables = { callerSlug: string }

const xAgentChat = new Hono<{ Variables: XAgentChatVariables }>()

xAgentChat.use('*', async (c, next) => {
  const token = c.req.header('Authorization')?.replace('Bearer ', '')
  if (!token) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  const callerSlug = await validateProxyToken(token)
  if (!callerSlug) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  c.set('callerSlug', callerSlug)
  await next()
})

function getCallerSlug(c: { get: (k: 'callerSlug') => string }): string {
  return c.get('callerSlug')
}

// POST /list — list integrations with active chat sessions
xAgentChat.post('/list', async (c) => {
  try {
    const callerSlug = getCallerSlug(c)
    const integrations = listChatIntegrations(callerSlug)

    const result = integrations.map((i) => {
      const sessions = listChatIntegrationSessions(i.id)
      const activeChats = sessions
        .filter((s) => !s.archivedAt)
        .map((s) => ({ chatId: s.externalChatId, displayName: s.displayName }))
      return {
        id: i.id,
        provider: i.provider,
        name: i.name,
        status: i.status,
        chats: activeChats,
      }
    })

    return c.json({ integrations: result })
  } catch (error) {
    captureException(error, { tags: { component: 'x-agent-chat', operation: 'list' } })
    return c.json({ error: 'Failed to list chat integrations' }, 500)
  }
})

// POST /add — create and connect a new integration
xAgentChat.post('/add', async (c) => {
  try {
    const callerSlug = getCallerSlug(c)
    const body = await c.req.json()
    const { provider, config, name } = body

    if (!provider || !config) {
      return c.json({ error: 'Missing required fields: provider, config' }, 400)
    }

    if (!CHAT_PROVIDERS.includes(provider)) {
      return c.json({ error: `Invalid provider. Must be one of: ${CHAT_PROVIDERS.join(', ')}` }, 400)
    }

    // iMessage code exchange
    if (provider === 'imessage' && config.code && !config.token) {
      const parsed = imessageSetupSchema.safeParse({ phoneNumber: config.phoneNumber, code: config.code })
      if (!parsed.success) {
        return c.json({ error: parsed.error.issues[0]?.message || 'Invalid phone number or code' }, 400)
      }
      const exchangeRes = await fetch(`${IMESSAGE_GATEWAY_URL}/auth/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: config.phoneNumber, code: config.code }),
      })
      if (exchangeRes.status === 401) {
        return c.json({ error: 'Invalid or expired verification code' }, 400)
      }
      if (exchangeRes.status === 429) {
        return c.json({ error: 'Too many attempts, try again later' }, 400)
      }
      if (!exchangeRes.ok) {
        return c.json({ error: `Code exchange failed (${exchangeRes.status})` }, 400)
      }
      const { token } = await exchangeRes.json() as { token: string }
      if (!token) {
        return c.json({ error: 'No token returned from gateway' }, 400)
      }
      config.token = token
      config.gatewayUrl = IMESSAGE_GATEWAY_URL
      delete config.code
    }

    try {
      validateChatIntegrationConfig(provider as ChatProvider, config)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invalid config'
      return c.json({ error: `Invalid config: ${message}` }, 400)
    }

    let id: string
    try {
      id = createChatIntegration({
        agentSlug: callerSlug,
        provider: provider as ChatProvider,
        name,
        config,
      })
    } catch (err) {
      if (err instanceof DuplicateBotTokenError) {
        return c.json({ error: err.message, code: 'duplicate_bot_token' }, 409)
      }
      throw err
    }

    try {
      await chatIntegrationManager.addIntegration(id)
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      updateChatIntegrationStatus(id, 'error', errMsg)
    }

    const created = getChatIntegration(id)
    if (!created) {
      return c.json({ error: 'Integration created but could not be retrieved' }, 500)
    }
    return c.json({
      id: created.id,
      provider: created.provider,
      status: created.status,
      name: created.name,
    }, 201)
  } catch (error) {
    captureException(error, { tags: { component: 'x-agent-chat', operation: 'add' } })
    return c.json({ error: 'Failed to add chat integration' }, 500)
  }
})

// POST /send — send a message through a connected integration
xAgentChat.post('/send', async (c) => {
  try {
    const callerSlug = getCallerSlug(c)
    const body = await c.req.json()
    const { integration_id, message, chat_id, context } = body

    if (!integration_id || !message) {
      return c.json({ error: 'Missing required fields: integration_id, message' }, 400)
    }

    const integration = getChatIntegration(integration_id)
    if (!integration) {
      return c.json({ error: 'Chat integration not found' }, 404)
    }
    if (integration.agentSlug !== callerSlug) {
      return c.json({ error: 'Chat integration does not belong to this agent' }, 403)
    }

    // Resolve chatId
    let resolvedChatId: string = chat_id
    if (!resolvedChatId) {
      const sessions = listChatIntegrationSessions(integration_id)
      const activeChats = sessions.filter((s) => !s.archivedAt)
      if (activeChats.length === 0) {
        return c.json({
          error: 'No active chats found for this integration. Someone needs to message the bot first, or specify a chat_id directly.',
        }, 400)
      }
      if (activeChats.length > 1) {
        const chatList = activeChats.map((s) =>
          `  - chatId: ${s.externalChatId}${s.displayName ? ` (${s.displayName})` : ''}`,
        ).join('\n')
        return c.json({
          error: `Multiple active chats — specify chat_id. Available:\n${chatList}`,
        }, 400)
      }
      resolvedChatId = activeChats[0].externalChatId
    }

    if (!isChatAllowed(integration_id, resolvedChatId)) {
      return c.json({ error: 'This conversation is not approved for this integration.' }, 403)
    }

    // Send through connector (with a brief "working" indicator first)
    let connector = chatIntegrationManager.getConnector(integration_id)
    if (!connector) {
      // Connector not live — attempt to reconnect
      // This can happen if the connector dropped or the manager restarted (HMR)
      console.warn(`[x-agent-chat] getConnector returned undefined for ${integration_id} (status: ${integration.status}), active IDs: [${chatIntegrationManager.getActiveIntegrationIds().join(', ')}]. Attempting reconnect.`)
      try {
        await chatIntegrationManager.addIntegration(integration_id)
        connector = chatIntegrationManager.getConnector(integration_id)
      } catch {
        // reconnection failed
      }
    }
    if (!connector) {
      return c.json({ error: 'Integration is not connected and reconnection failed.' }, 400)
    }

    const typingDelay = 100 + Math.random() * 1100
    await connector.startWorking(resolvedChatId).catch(() => {})
    await new Promise((resolve) => setTimeout(resolve, typingDelay))

    await connector.sendMessage(resolvedChatId, { text: message })
    // One-shot send (no streaming follow-up), so clear the indicator we started.
    await connector.stopWorking(resolvedChatId).catch(() => {})

    // Notify the chat session's agent so it knows a message was sent on its behalf.
    // Uses shouldQuery: false so the message enters the agent's context without
    // triggering a new assistant turn.
    try {
      await notifySessionOfOutboundMessage(integration_id, integration.agentSlug, resolvedChatId, message, context)
    } catch (err) {
      // Best-effort — don't fail the send if notification fails
      captureException(err, {
        tags: { component: 'x-agent-chat', operation: 'send-notify' },
        extra: { integrationId: integration_id, chatId: resolvedChatId },
        level: 'warning',
      })
    }

    return c.json({ chatId: resolvedChatId, provider: integration.provider })
  } catch (error) {
    captureException(error, { tags: { component: 'x-agent-chat', operation: 'send' } })
    return c.json({ error: 'Failed to send chat message' }, 500)
  }
})

// POST /share-dashboard — share a dashboard artifact to a Telegram chat
xAgentChat.post('/share-dashboard', zValidator('json', shareDashboardRequestSchema), async (c) => {
  try {
    const callerSlug = getCallerSlug(c)
    const { slug, integration_id, chat_id } = c.req.valid('json')

    // Resolve integration
    let integration: Awaited<ReturnType<typeof getChatIntegration>>
    if (integration_id) {
      const found = getChatIntegration(integration_id)
      if (!found) return c.json({ error: 'Chat integration not found' }, 404)
      if (found.agentSlug !== callerSlug) return c.json({ error: 'Forbidden' }, 403)
      if (found.provider !== 'telegram') return c.json({ error: 'Dashboards are only supported on Telegram' }, 400)
      integration = found
    } else {
      const active = listChatIntegrations(callerSlug).filter(
        (i) => i.provider === 'telegram' && i.status === 'active',
      )
      if (active.length === 0) return c.json({ error: 'No active Telegram integration for this agent' }, 400)
      if (active.length > 1) return c.json({ error: 'Multiple Telegram integrations; specify integration_id' }, 400)
      integration = active[0]
    }

    // Resolve chat
    let resolvedChatId: string
    if (chat_id) {
      resolvedChatId = chat_id
    } else {
      const sessions = listChatIntegrationSessions(integration.id)
      const active = sessions.filter((s) => !s.archivedAt)
      if (active.length === 0) return c.json({ error: 'No active chat for this integration' }, 400)
      if (active.length > 1) return c.json({ error: 'Multiple active chats; specify chat_id' }, 400)
      resolvedChatId = active[0].externalChatId
    }

    // Same access-control gate as /send: never deliver to a conversation that isn't approved.
    if (!isChatAllowed(integration.id, resolvedChatId)) {
      return c.json({ error: 'This conversation is not approved for this integration.' }, 403)
    }

    // Validate dashboard existence
    const artifacts = await listArtifactsFromFilesystem(integration.agentSlug)
    const dash = artifacts.find((a) => a.slug === slug)
    if (!dash) return c.json({ error: 'Dashboard not found' }, 404)
    const name = dash.name || slug

    let delivery: DashboardDelivery
    try {
      delivery = await chatIntegrationManager.shareDashboard(integration.id, resolvedChatId, {
        agentSlug: integration.agentSlug,
        dashboardSlug: slug,
        name,
      })
    } catch (err) {
      if (err instanceof Error && err.message === 'Integration not connected') {
        return c.json({ error: 'Integration not connected' }, 503)
      }
      throw err
    }

    return c.json({ chatId: resolvedChatId, delivery })
  } catch (error) {
    captureException(error, { tags: { component: 'x-agent-chat', operation: 'share-dashboard' } })
    return c.json({ error: 'Failed to share dashboard' }, 500)
  }
})

// --- Helpers ---

async function notifySessionOfOutboundMessage(
  integrationId: string,
  agentSlug: string,
  chatId: string,
  message: string,
  context?: string,
): Promise<void> {
  const sessionId = await chatIntegrationManager.ensureSession(integrationId, chatId)

  const notificationText = context
    ? `[SYSTEM] A message was sent to the user on your behalf via chat integration:\n[Internal context: ${context}]\n\n${message}`
    : `[SYSTEM] A message was sent to the user on your behalf via chat integration:\n${message}`

  // Try the SDK-aware path (appends to transcript without triggering a response).
  // Falls back to raw JSONL if the container isn't running or the session doesn't
  // exist on the container yet (e.g. ensureSession just created a lightweight session).
  try {
    const client = await containerManager.ensureRunning(agentSlug)
    await client.sendMessage(sessionId, notificationText, undefined, { shouldQuery: false })
  } catch {
    appendAssistantMessage(agentSlug, sessionId, notificationText)
  }
}

function appendAssistantMessage(agentSlug: string, sessionId: string, text: string): void {
  const jsonlPath = getSessionJsonlPath(agentSlug, sessionId)
  const dir = path.dirname(jsonlPath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  const entry = {
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
    uuid: randomUUID(),
    parentUuid: null,
    sessionId,
    timestamp: new Date().toISOString(),
  }
  fs.appendFileSync(jsonlPath, JSON.stringify(entry) + '\n')
}

export default xAgentChat
