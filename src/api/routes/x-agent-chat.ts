import { Hono } from 'hono'
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
  getChatIntegrationSessionBySessionId,
} from '@shared/lib/services/chat-integration-session-service'
import { chatIntegrationManager } from '@shared/lib/chat-integrations/chat-integration-manager'
import type { ChatClientConnector, ChatDiscoveryCapability } from '@shared/lib/chat-integrations/base-connector'
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

    const result = await Promise.all(integrations.map(async (i) => {
      // Static (per-provider) lookups: label each chat with its conversation
      // type where the provider's ids encode one, and advertise discovery
      // capabilities so agents know which discovery tools apply here.
      const connectorClass = await chatIntegrationManager.getConnectorClass(i.provider)
      const sessions = listChatIntegrationSessions(i.id)
      const activeChats = sessions
        .filter((s) => !s.archivedAt)
        .map((s) => {
          const type = connectorClass?.classifyChatId?.(s.externalChatId)
          return {
            chatId: s.externalChatId,
            displayName: s.displayName,
            ...(type ? { type } : {}),
          }
        })
      return {
        id: i.id,
        provider: i.provider,
        name: i.name,
        status: i.status,
        capabilities: connectorClass?.discoveryCapabilities ?? [],
        chats: activeChats,
      }
    }))

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
    const { integration_id, message, chat_id, user_id, context, session_id } = body

    if (!integration_id || !message) {
      return c.json({ error: 'Missing required fields: integration_id, message' }, 400)
    }
    if (chat_id && user_id) {
      return c.json({ error: 'Pass either chat_id or user_id, not both.' }, 400)
    }

    const integration = getChatIntegration(integration_id)
    if (!integration) {
      return c.json({ error: 'Chat integration not found' }, 404)
    }
    if (integration.agentSlug !== callerSlug) {
      return c.json({ error: 'Chat integration does not belong to this agent' }, 403)
    }

    // Static capability check first: an unsupported provider must get the
    // "unsupported" answer without the connector ever being touched (a
    // reconnect attempt could otherwise resurrect it or mask the real error).
    if (user_id) {
      const connectorClass = await chatIntegrationManager.getConnectorClass(integration.provider)
      if (!connectorClass?.discoveryCapabilities?.includes('dm_by_user_id')) {
        return c.json({
          error: `The ${integration.provider} provider does not support messaging by user_id. Pass a chat_id instead (see list_chat_integrations).`,
        }, 400)
      }
    }

    const connector = await resolveLiveConnector(integration_id, integration.status)
    if (!connector) {
      return c.json({ error: 'Integration is not connected and reconnection failed.' }, 400)
    }

    // A user_id targets a person rather than a chat: resolve (or open) the 1:1
    // conversation up front so the own-chat guard below sees the REAL chat id —
    // a DM addressed by user id can still land in the caller's own chat.
    let resolvedChatId: string | undefined = chat_id
    if (user_id) {
      if (typeof connector.resolveDirectChat !== 'function') {
        return c.json({
          error: `The ${integration.provider} provider does not support messaging by user_id. Pass a chat_id instead (see list_chat_integrations).`,
        }, 400)
      }
      try {
        resolvedChatId = await connector.resolveDirectChat(user_id)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return c.json({ error: `Could not open a direct chat with user ${user_id}: ${msg}` }, 400)
      }
      // Audit trail for proactive first contact: the send itself is also logged
      // into the chat's session transcript via notifySessionOfOutboundMessage.
      console.log(`[x-agent-chat] Resolved user ${user_id} to direct chat ${resolvedChatId} on integration ${integration_id}`)
    }

    // A session spawned BY a chat conversation already has its replies streamed
    // back to that chat, so a send targeting its own chat would double-post —
    // and omitting the target historically made such agents guess one from
    // the integration-wide list and misroute DMs. Reject both; explicit sends
    // to a DIFFERENT chat stay allowed (the legitimate "DM someone while
    // responding in a channel" case). Archived rows don't guard: once a chat
    // session is rotated out, its SSE forwarding is torn down, so an outbound
    // send is the only remaining delivery path.
    if (session_id) {
      const callerChatSession = getChatIntegrationSessionBySessionId(session_id)
      if (
        callerChatSession
        && !callerChatSession.archivedAt
        && callerChatSession.integrationId === integration_id
        && (!resolvedChatId || resolvedChatId === callerChatSession.externalChatId)
      ) {
        const label = callerChatSession.displayName ? ` (${callerChatSession.displayName})` : ''
        return c.json({
          error: `Not sent: this session IS the live conversation for chat ${callerChatSession.externalChatId}${label}. Everything you write in your response is delivered to that chat automatically — sending it here too would post it twice. To message a different chat, pass its chat_id (see list_chat_integrations).`,
        }, 400)
      }
    }

    // No explicit target: fall back to the integration's single active chat
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
    const typingDelay = 100 + Math.random() * 1100
    await connector.startWorking(resolvedChatId, 'working').catch(() => {})
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

// POST /users — list people reachable through the integration's directory
xAgentChat.post('/users', async (c) => {
  try {
    const directory = await resolveDirectoryConnector(c, 'listChatUsers')
    if ('response' in directory) return directory.response
    const page = await directory.connector.listChatUsers!()
    return c.json({ provider: directory.provider, users: page.items, truncated: page.truncated })
  } catch (error) {
    captureException(error, { tags: { component: 'x-agent-chat', operation: 'users' } })
    return c.json({ error: 'Failed to list chat users' }, 500)
  }
})

// POST /channels — list channels/groups the bot could post into
xAgentChat.post('/channels', async (c) => {
  try {
    const directory = await resolveDirectoryConnector(c, 'listChatChannels')
    if ('response' in directory) return directory.response
    const page = await directory.connector.listChatChannels!()
    return c.json({ provider: directory.provider, channels: page.items, truncated: page.truncated })
  } catch (error) {
    captureException(error, { tags: { component: 'x-agent-chat', operation: 'channels' } })
    return c.json({ error: 'Failed to list chat channels' }, 500)
  }
})

// --- Helpers ---

/**
 * Get the live connector for an integration, attempting one reconnect when it
 * isn't registered (connector dropped, or the manager restarted under HMR).
 */
async function resolveLiveConnector(
  integrationId: string,
  integrationStatus: string,
): Promise<ChatClientConnector | undefined> {
  let connector = chatIntegrationManager.getConnector(integrationId)
  if (!connector) {
    console.warn(`[x-agent-chat] getConnector returned undefined for ${integrationId} (status: ${integrationStatus}), active IDs: [${chatIntegrationManager.getActiveIntegrationIds().join(', ')}]. Attempting reconnect.`)
    try {
      await chatIntegrationManager.addIntegration(integrationId)
      connector = chatIntegrationManager.getConnector(integrationId)
    } catch {
      // reconnection failed
    }
  }
  return connector
}

const DIRECTORY_CAPABILITIES = {
  listChatUsers: { label: 'listing users', capability: 'list_users' },
  listChatChannels: { label: 'listing channels', capability: 'list_channels' },
} as const satisfies Record<string, { label: string; capability: ChatDiscoveryCapability }>

/**
 * Shared preamble for the directory endpoints: auth/ownership checks, the
 * capability check, and live connector resolution. Returns { response } to
 * short-circuit, or the ready connector.
 */
async function resolveDirectoryConnector(
  c: { get: (k: 'callerSlug') => string; req: { json: () => Promise<unknown> }; json: (body: unknown, status?: 400 | 403 | 404) => Response },
  capability: keyof typeof DIRECTORY_CAPABILITIES,
): Promise<{ response: Response } | { connector: ChatClientConnector; provider: string }> {
  const callerSlug = getCallerSlug(c)
  const body = await c.req.json() as { integration_id?: string }
  const integrationId = body?.integration_id
  if (!integrationId) {
    return { response: c.json({ error: 'Missing required field: integration_id' }, 400) }
  }

  const integration = getChatIntegration(integrationId)
  if (!integration) {
    return { response: c.json({ error: 'Chat integration not found' }, 404) }
  }
  if (integration.agentSlug !== callerSlug) {
    return { response: c.json({ error: 'Chat integration does not belong to this agent' }, 403) }
  }

  // Capability is a static property of the provider — check it BEFORE touching
  // the connector, so an unsupported provider gets the promised "unsupported"
  // answer (never a connection error) and, crucially, no integration is
  // reconnected just to discover it can't serve the request.
  const { label, capability: capabilityName } = DIRECTORY_CAPABILITIES[capability]
  const connectorClass = await chatIntegrationManager.getConnectorClass(integration.provider)
  if (!connectorClass?.discoveryCapabilities?.includes(capabilityName)) {
    return {
      response: c.json({
        error: `The ${integration.provider} provider does not support ${label}.`,
      }, 400),
    }
  }
  // A directory read must not resurrect an integration the owner paused.
  if (integration.status === 'paused') {
    return { response: c.json({ error: 'Integration is paused. Resume it before using directory listings.' }, 400) }
  }

  const connector = await resolveLiveConnector(integrationId, integration.status)
  if (!connector) {
    return { response: c.json({ error: 'Integration is not connected and reconnection failed.' }, 400) }
  }
  // Defensive: the static declaration and the instance implementation come
  // from the same class, so this only fires on a connector/class mismatch.
  if (typeof connector[capability] !== 'function') {
    return {
      response: c.json({
        error: `The ${integration.provider} provider does not support ${label}.`,
      }, 400),
    }
  }
  return { connector, provider: integration.provider }
}

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
