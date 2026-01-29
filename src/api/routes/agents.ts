import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import Anthropic from '@anthropic-ai/sdk'
import {
  listAgentsWithStatus,
  createAgent,
  getAgentWithStatus,
  getAgent,
  updateAgent,
  deleteAgent,
  agentExists,
} from '@shared/lib/services/agent-service'
import { containerManager } from '@shared/lib/container/container-manager'
import { messagePersister } from '@shared/lib/container/message-persister'
import {
  listSessions,
  updateSessionName,
  registerSession,
  getSessionMessages,
  getSession,
  deleteSession,
} from '@shared/lib/services/session-service'
import {
  listSecrets,
  getSecret,
  setSecret,
  deleteSecret,
  keyToEnvVar,
  getSecretEnvVars,
} from '@shared/lib/services/secrets-service'
import {
  listScheduledTasks,
  listPendingScheduledTasks,
} from '@shared/lib/services/scheduled-task-service'
import { db } from '@shared/lib/db'
import { connectedAccounts, agentConnectedAccounts, proxyAuditLog } from '@shared/lib/db/schema'
import { eq, inArray, desc, count } from 'drizzle-orm'
import { getProvider } from '@shared/lib/composio/providers'
import { getAgentSkills } from '@shared/lib/skills'
import { withRetry } from '@shared/lib/utils/retry'
import { transformMessages } from '@shared/lib/utils/message-transform'
import { getEffectiveAnthropicApiKey } from '@shared/lib/config/settings'
import { revokeProxyToken } from '@shared/lib/proxy/token-store'
import { getAgentWorkspaceDir } from '@shared/lib/utils/file-storage'
import * as fs from 'fs'
import * as path from 'path'

const agents = new Hono()

// Create Anthropic client lazily to use API key from settings
function getAnthropicClient(): Anthropic {
  const apiKey = getEffectiveAnthropicApiKey()
  if (!apiKey) {
    throw new Error('Anthropic API key not configured')
  }
  return new Anthropic({ apiKey })
}

// Model used for generating session names (lightweight task)
const SUMMARIZER_MODEL = process.env.SUMMARIZER_MODEL || 'claude-haiku-4-5'

// Generate session name using AI (fire and forget)
async function generateAndUpdateSessionNameAsync(
  agentSlug: string,
  sessionId: string,
  message: string,
  agentName: string
): Promise<void> {
  try {
    const anthropic = getAnthropicClient()
    const response = await withRetry(() =>
      anthropic.messages.create({
        model: SUMMARIZER_MODEL,
        max_tokens: 50,
        messages: [
          {
            role: 'user',
            content: `Generate a short, descriptive session name (3-6 words max) for a conversation with an AI agent named "${agentName}". The first message in the conversation is:

"${message}"

Respond with ONLY the session name, nothing else. No quotes, no explanation.`,
          },
        ],
      })
    )

    const textBlock = response.content.find((block) => block.type === 'text')
    const sessionName = textBlock?.type === 'text' ? textBlock.text.trim() : null

    if (sessionName) {
      await updateSessionName(agentSlug, sessionId, sessionName)
      messagePersister.broadcastSessionUpdate(sessionId)
    }
  } catch (error) {
    console.error('Failed to generate session name after retries:', error)
  }
}

// GET /api/agents - List all agents with status
agents.get('/', async (c) => {
  try {
    const agentList = await listAgentsWithStatus()
    return c.json(agentList)
  } catch (error) {
    console.error('Failed to fetch agents:', error)
    return c.json({ error: 'Failed to fetch agents' }, 500)
  }
})

// POST /api/agents - Create a new agent
agents.post('/', async (c) => {
  try {
    const body = await c.req.json()
    const { name, description } = body

    if (!name?.trim()) {
      return c.json({ error: 'Name is required' }, 400)
    }

    const agent = await createAgent({
      name: name.trim(),
      description: description?.trim(),
    })

    return c.json(agent, 201)
  } catch (error) {
    console.error('Failed to create agent:', error)
    return c.json({ error: 'Failed to create agent' }, 500)
  }
})

// GET /api/agents/:id - Get a single agent
agents.get('/:id', async (c) => {
  try {
    const slug = c.req.param('id')
    const agent = await getAgentWithStatus(slug)

    if (!agent) {
      return c.json({ error: 'Agent not found' }, 404)
    }

    return c.json(agent)
  } catch (error) {
    console.error('Failed to fetch agent:', error)
    return c.json({ error: 'Failed to fetch agent' }, 500)
  }
})

// PUT /api/agents/:id - Update an agent
agents.put('/:id', async (c) => {
  try {
    const slug = c.req.param('id')
    const body = await c.req.json()
    const { name, description, instructions } = body

    const agent = await updateAgent(slug, {
      name: name?.trim(),
      description: description?.trim(),
      instructions: instructions,
    })

    if (!agent) {
      return c.json({ error: 'Agent not found' }, 404)
    }

    return c.json(agent)
  } catch (error) {
    console.error('Failed to update agent:', error)
    return c.json({ error: 'Failed to update agent' }, 500)
  }
})

// DELETE /api/agents/:id - Delete an agent
agents.delete('/:id', async (c) => {
  try {
    const slug = c.req.param('id')
    const deleted = await deleteAgent(slug)

    if (!deleted) {
      return c.json({ error: 'Agent not found' }, 404)
    }

    containerManager.removeClient(slug)

    // Clean up proxy token
    try {
      await revokeProxyToken(slug)
    } catch (error) {
      console.error('Failed to revoke proxy token:', error)
    }

    return c.body(null, 204)
  } catch (error) {
    console.error('Failed to delete agent:', error)
    return c.json({ error: 'Failed to delete agent' }, 500)
  }
})

// POST /api/agents/:id/start - Start an agent's container
agents.post('/:id/start', async (c) => {
  try {
    const slug = c.req.param('id')

    if (!(await agentExists(slug))) {
      return c.json({ error: 'Agent not found' }, 404)
    }

    await containerManager.ensureRunning(slug)
    const agent = await getAgentWithStatus(slug)

    // Note: agent_status_changed is broadcast by containerManager.ensureRunning()

    return c.json(agent)
  } catch (error) {
    console.error('Failed to start agent:', error)
    return c.json({ error: 'Failed to start agent' }, 500)
  }
})

// POST /api/agents/:id/stop - Stop an agent's container
agents.post('/:id/stop', async (c) => {
  try {
    const slug = c.req.param('id')
    const agent = await getAgent(slug)

    if (!agent) {
      return c.json({ error: 'Agent not found' }, 404)
    }

    const client = containerManager.getClient(slug)
    const info = await client.getInfo()

    if (info.status === 'stopped') {
      return c.json({
        slug: agent.slug,
        name: agent.frontmatter.name,
        description: agent.frontmatter.description,
        createdAt: agent.frontmatter.createdAt,
        status: 'stopped',
        containerPort: null,
        message: 'Agent is already stopped',
      })
    }

    await client.stop()

    // Broadcast agent status change globally
    console.log('[Agents] Broadcasting agent_status_changed for', slug, 'status: stopped')
    messagePersister.broadcastGlobal({
      type: 'agent_status_changed',
      agentSlug: slug,
      status: 'stopped',
    })

    return c.json({
      slug: agent.slug,
      name: agent.frontmatter.name,
      description: agent.frontmatter.description,
      createdAt: agent.frontmatter.createdAt,
      status: 'stopped',
      containerPort: null,
    })
  } catch (error) {
    console.error('Failed to stop agent:', error)
    return c.json({ error: 'Failed to stop agent' }, 500)
  }
})

// GET /api/agents/:id/sessions - List sessions for an agent
agents.get('/:id/sessions', async (c) => {
  try {
    const slug = c.req.param('id')

    if (!(await agentExists(slug))) {
      return c.json({ error: 'Agent not found' }, 404)
    }

    const sessionList = await listSessions(slug)
    const sessionsWithStatus = sessionList.map((session) => ({
      ...session,
      isActive: messagePersister.isSessionActive(session.id),
    }))

    return c.json(sessionsWithStatus)
  } catch (error) {
    console.error('Failed to fetch sessions:', error)
    return c.json({ error: 'Failed to fetch sessions' }, 500)
  }
})

// POST /api/agents/:id/sessions - Create a new session with initial message
agents.post('/:id/sessions', async (c) => {
  try {
    const slug = c.req.param('id')
    const body = await c.req.json()
    const { message } = body

    if (!message?.trim()) {
      return c.json({ error: 'Message is required' }, 400)
    }

    const agent = await getAgent(slug)
    if (!agent) {
      return c.json({ error: 'Agent not found' }, 404)
    }

    const client = await containerManager.ensureRunning(slug)
    const availableEnvVars = await getSecretEnvVars(slug)

    const containerSession = await client.createSession({
      availableEnvVars: availableEnvVars.length > 0 ? availableEnvVars : undefined,
      initialMessage: message.trim(),
    })
    const sessionId = containerSession.id

    await registerSession(slug, sessionId, 'New Session')
    messagePersister.subscribeToSession(sessionId, client, sessionId, slug)
    messagePersister.markSessionActive(sessionId, slug)

    generateAndUpdateSessionNameAsync(
      slug,
      sessionId,
      message.trim(),
      agent.frontmatter.name
    ).catch(console.error)

    return c.json(
      {
        id: sessionId,
        agentSlug: slug,
        name: 'New Session',
        createdAt: new Date(),
        lastActivityAt: new Date(),
        messageCount: 0,
        isActive: true,
      },
      201
    )
  } catch (error) {
    console.error('Failed to create session:', error)
    return c.json({ error: 'Failed to create session' }, 500)
  }
})

// GET /api/agents/:id/sessions/:sessionId/messages - Get messages for a session
agents.get('/:id/sessions/:sessionId/messages', async (c) => {
  try {
    const agentSlug = c.req.param('id')
    const sessionId = c.req.param('sessionId')

    if (!(await agentExists(agentSlug))) {
      return c.json({ error: 'Agent not found' }, 404)
    }

    const messages = await getSessionMessages(agentSlug, sessionId)
    const filtered = messages.filter((m) => !('isMeta' in m && m.isMeta))
    const transformed = transformMessages(filtered)

    return c.json(transformed)
  } catch (error) {
    console.error('Failed to fetch messages:', error)
    return c.json({ error: 'Failed to fetch messages' }, 500)
  }
})

// POST /api/agents/:id/sessions/:sessionId/messages - Send a message
agents.post('/:id/sessions/:sessionId/messages', async (c) => {
  try {
    const agentSlug = c.req.param('id')
    const sessionId = c.req.param('sessionId')
    const body = await c.req.json()
    const { content } = body

    if (!content?.trim()) {
      return c.json({ error: 'Content is required' }, 400)
    }

    const agent = await getAgent(agentSlug)
    if (!agent) {
      return c.json({ error: 'Agent not found' }, 404)
    }

    const client = containerManager.getClient(agentSlug)
    let info = await client.getInfo()

    if (info.status !== 'running') {
      await containerManager.ensureRunning(agentSlug)
      info = await client.getInfo()
    }

    if (!messagePersister.isSubscribed(sessionId)) {
      messagePersister.subscribeToSession(sessionId, client, sessionId, agentSlug)
    }

    messagePersister.markSessionActive(sessionId, agentSlug)
    await client.sendMessage(sessionId, content.trim())

    return c.json({ success: true }, 201)
  } catch (error) {
    console.error('Failed to send message:', error)
    return c.json({ error: 'Failed to send message' }, 500)
  }
})

// GET /api/agents/:id/sessions/:sessionId - Get a single session
agents.get('/:id/sessions/:sessionId', async (c) => {
  try {
    const agentSlug = c.req.param('id')
    const sessionId = c.req.param('sessionId')

    if (!(await agentExists(agentSlug))) {
      return c.json({ error: 'Agent not found' }, 404)
    }

    const session = await getSession(agentSlug, sessionId)

    if (!session) {
      return c.json({ error: 'Session not found' }, 404)
    }

    const isActive = messagePersister.isSessionActive(sessionId)

    return c.json({
      id: session.id,
      agentSlug: session.agentSlug,
      name: session.name,
      createdAt: session.createdAt,
      lastActivityAt: session.lastActivityAt,
      messageCount: session.messageCount,
      isActive,
    })
  } catch (error) {
    console.error('Failed to fetch session:', error)
    return c.json({ error: 'Failed to fetch session' }, 500)
  }
})

// PATCH /api/agents/:id/sessions/:sessionId - Update a session (e.g., rename)
agents.patch('/:id/sessions/:sessionId', async (c) => {
  try {
    const agentSlug = c.req.param('id')
    const sessionId = c.req.param('sessionId')
    const body = await c.req.json()
    const { name } = body

    if (!(await agentExists(agentSlug))) {
      return c.json({ error: 'Agent not found' }, 404)
    }

    const session = await getSession(agentSlug, sessionId)

    if (!session) {
      return c.json({ error: 'Session not found' }, 404)
    }

    if (name?.trim()) {
      await updateSessionName(agentSlug, sessionId, name.trim())
    }

    const updated = await getSession(agentSlug, sessionId)

    return c.json({
      id: updated?.id || sessionId,
      agentSlug: updated?.agentSlug || agentSlug,
      name: updated?.name || name?.trim() || session.name,
      createdAt: updated?.createdAt || session.createdAt,
      lastActivityAt: updated?.lastActivityAt || session.lastActivityAt,
      messageCount: updated?.messageCount || session.messageCount,
    })
  } catch (error) {
    console.error('Failed to update session:', error)
    return c.json({ error: 'Failed to update session' }, 500)
  }
})

// DELETE /api/agents/:id/sessions/:sessionId - Delete a session
agents.delete('/:id/sessions/:sessionId', async (c) => {
  try {
    const agentSlug = c.req.param('id')
    const sessionId = c.req.param('sessionId')

    if (!(await agentExists(agentSlug))) {
      return c.json({ error: 'Agent not found' }, 404)
    }

    const session = await getSession(agentSlug, sessionId)

    if (!session) {
      return c.json({ error: 'Session not found' }, 404)
    }

    messagePersister.unsubscribeFromSession(sessionId)
    await deleteSession(agentSlug, sessionId)

    return c.body(null, 204)
  } catch (error) {
    console.error('Failed to delete session:', error)
    return c.json({ error: 'Failed to delete session' }, 500)
  }
})

// GET /api/agents/:id/sessions/:sessionId/stream - SSE stream for real-time message updates
agents.get('/:id/sessions/:sessionId/stream', async (c) => {
  const sessionId = c.req.param('sessionId')

  return streamSSE(c, async (stream) => {
    let pingInterval: ReturnType<typeof setInterval> | null = null
    let unsubscribe: (() => void) | null = null

    try {
      // Subscribe FIRST to avoid missing any broadcasts
      unsubscribe = messagePersister.addSSEClient(sessionId, async (data) => {
        try {
          await stream.writeSSE({
            data: JSON.stringify(data),
            event: 'message',
          })
        } catch (error) {
          console.error('Error sending SSE message:', error)
        }
      })

      // Send initial connection message
      const isActive = messagePersister.isSessionActive(sessionId)
      await stream.writeSSE({
        data: JSON.stringify({ type: 'connected', isActive }),
        event: 'message',
      })

      // Keep-alive ping every 30 seconds
      pingInterval = setInterval(async () => {
        try {
          const currentIsActive = messagePersister.isSessionActive(sessionId)
          await stream.writeSSE({
            data: JSON.stringify({ type: 'ping', isActive: currentIsActive }),
            event: 'message',
          })
        } catch {
          if (pingInterval) clearInterval(pingInterval)
        }
      }, 30000)

      // Wait for abort signal
      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          resolve()
        })
      })
    } finally {
      if (pingInterval) clearInterval(pingInterval)
      if (unsubscribe) unsubscribe()
    }
  })
})

// POST /api/agents/:id/sessions/:sessionId/interrupt - Interrupt an active session
agents.post('/:id/sessions/:sessionId/interrupt', async (c) => {
  try {
    const agentSlug = c.req.param('id')
    const sessionId = c.req.param('sessionId')

    if (!(await agentExists(agentSlug))) {
      return c.json({ error: 'Agent not found' }, 404)
    }

    const client = containerManager.getClient(agentSlug)
    const info = await client.getInfo()

    if (info.status !== 'running') {
      return c.json({ error: 'Agent container is not running' }, 400)
    }

    const interrupted = await client.interruptSession(sessionId)

    if (!interrupted) {
      return c.json({ error: 'Failed to interrupt session' }, 500)
    }

    await messagePersister.markSessionInterrupted(sessionId)

    return c.json({ success: true })
  } catch (error) {
    console.error('Failed to interrupt session:', error)
    return c.json({ error: 'Failed to interrupt session' }, 500)
  }
})

// POST /api/agents/:id/sessions/:sessionId/provide-secret - Provide or decline a secret request
agents.post('/:id/sessions/:sessionId/provide-secret', async (c) => {
  try {
    const agentSlug = c.req.param('id')
    const body = await c.req.json()
    const { toolUseId, secretName, value, decline, declineReason } = body

    if (!toolUseId) {
      return c.json({ error: 'toolUseId is required' }, 400)
    }

    if (!secretName) {
      return c.json({ error: 'secretName is required' }, 400)
    }

    if (!(await agentExists(agentSlug))) {
      return c.json({ error: 'Agent not found' }, 404)
    }

    const client = containerManager.getClient(agentSlug)

    if (decline) {
      const reason = declineReason || 'User declined to provide the secret'

      const rejectResponse = await client.fetch(
        `/inputs/${encodeURIComponent(toolUseId)}/reject`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason }),
        }
      )

      if (!rejectResponse.ok) {
        const error = await rejectResponse.json()
        console.error('Failed to reject secret request:', error)
        return c.json({ error: 'Failed to reject secret request' }, 500)
      }

      return c.json({ success: true, declined: true })
    }

    if (!value) {
      return c.json({ error: 'value is required when not declining' }, 400)
    }

    // Save the secret to .env file
    await setSecret(agentSlug, {
      key: secretName,
      envVar: secretName,
      value,
    })

    // Set environment variable in container FIRST
    console.log(`[provide-secret] Setting env var ${secretName} in container`)
    const envResponse = await client.fetch('/env', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: secretName, value }),
    })

    if (!envResponse.ok) {
      let errorDetails = 'Unknown error'
      try {
        const error = await envResponse.json()
        errorDetails = JSON.stringify(error)
      } catch {
        errorDetails = await envResponse.text()
      }
      console.error(`[provide-secret] Failed to set env var: ${errorDetails}`)
      return c.json(
        { error: 'Failed to set environment variable in container' },
        500
      )
    }
    console.log(`[provide-secret] Env var ${secretName} set successfully`)

    // Resolve the pending input request
    console.log(`[provide-secret] Resolving pending request ${toolUseId}`)
    const resolveResponse = await client.fetch(
      `/inputs/${encodeURIComponent(toolUseId)}/resolve`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value }),
      }
    )

    if (!resolveResponse.ok) {
      let errorDetails = 'Unknown error'
      try {
        const error = await resolveResponse.json()
        errorDetails = JSON.stringify(error)
      } catch {
        errorDetails = await resolveResponse.text()
      }
      console.error(
        `[provide-secret] Failed to resolve request: ${errorDetails}`
      )
      return c.json({ error: 'Secret saved but failed to notify agent' }, 500)
    }
    console.log(`[provide-secret] Request ${toolUseId} resolved successfully`)

    return c.json({ success: true, saved: true })
  } catch (error) {
    console.error('Failed to provide secret:', error)
    return c.json({ error: 'Failed to provide secret' }, 500)
  }
})

// POST /api/agents/:id/sessions/:sessionId/provide-connected-account - Provide or decline a connected account request
agents.post('/:id/sessions/:sessionId/provide-connected-account', async (c) => {
  try {
    const agentSlug = c.req.param('id')
    const body = await c.req.json()
    const { toolUseId, toolkit, accountIds, decline, declineReason } = body

    if (!toolUseId) {
      return c.json({ error: 'toolUseId is required' }, 400)
    }

    if (!toolkit) {
      return c.json({ error: 'toolkit is required' }, 400)
    }

    if (!(await agentExists(agentSlug))) {
      return c.json({ error: 'Agent not found' }, 404)
    }

    const client = containerManager.getClient(agentSlug)

    if (decline) {
      const reason = declineReason || 'User declined to provide access'

      const rejectResponse = await client.fetch(
        `/inputs/${encodeURIComponent(toolUseId)}/reject`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason }),
        }
      )

      if (!rejectResponse.ok) {
        const error = await rejectResponse.json()
        console.error('Failed to reject connected account request:', error)
        return c.json({ error: 'Failed to reject request' }, 500)
      }

      return c.json({ success: true, declined: true })
    }

    if (!accountIds || accountIds.length === 0) {
      return c.json(
        { error: 'accountIds is required when not declining' },
        400
      )
    }

    // Get the selected accounts
    const accounts = await db
      .select()
      .from(connectedAccounts)
      .where(inArray(connectedAccounts.id, accountIds))

    if (accounts.length === 0) {
      return c.json({ error: 'No valid accounts found' }, 400)
    }

    // Filter to accounts matching the toolkit
    const validAccounts = accounts.filter((a) => a.toolkitSlug === toolkit)
    if (validAccounts.length === 0) {
      return c.json(
        { error: `No accounts found for toolkit '${toolkit}'` },
        400
      )
    }

    // Map accounts to agent (if not already mapped)
    const now = new Date()
    for (const account of validAccounts) {
      try {
        await db.insert(agentConnectedAccounts).values({
          id: crypto.randomUUID(),
          agentSlug,
          connectedAccountId: account.id,
          createdAt: now,
        })
      } catch {
        // Ignore duplicate mapping errors
      }
    }

    // Build updated account metadata for the container (no tokens, just names + IDs)
    const allMappings = await db
      .select({ account: connectedAccounts })
      .from(agentConnectedAccounts)
      .innerJoin(
        connectedAccounts,
        eq(agentConnectedAccounts.connectedAccountId, connectedAccounts.id)
      )
      .where(eq(agentConnectedAccounts.agentSlug, agentSlug))

    const metadata: Record<string, Array<{ name: string; id: string }>> = {}
    for (const { account } of allMappings) {
      if (account.status !== 'active') continue
      if (!metadata[account.toolkitSlug]) {
        metadata[account.toolkitSlug] = []
      }
      metadata[account.toolkitSlug].push({
        name: account.displayName,
        id: account.id,
      })
    }

    // Update CONNECTED_ACCOUNTS metadata in container (no raw tokens)
    console.log(
      `[provide-connected-account] Updating CONNECTED_ACCOUNTS metadata in container`
    )
    const envResponse = await client.fetch('/env', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key: 'CONNECTED_ACCOUNTS',
        value: JSON.stringify(metadata),
      }),
    })

    if (!envResponse.ok) {
      let errorDetails = 'Unknown error'
      try {
        const error = await envResponse.json()
        errorDetails = JSON.stringify(error)
      } catch {
        errorDetails = await envResponse.text()
      }
      console.error(
        `[provide-connected-account] Failed to update metadata: ${errorDetails}`
      )
      return c.json(
        { error: 'Failed to update account metadata in container' },
        500
      )
    }
    console.log(
      `[provide-connected-account] CONNECTED_ACCOUNTS metadata updated`
    )

    // Resolve the pending input request
    console.log(
      `[provide-connected-account] Resolving pending request ${toolUseId}`
    )
    const accountNames = validAccounts.map((a) => a.displayName)
    const resolveResponse = await client.fetch(
      `/inputs/${encodeURIComponent(toolUseId)}/resolve`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          value: `Access granted to ${accountNames.length} account(s): ${accountNames.join(', ')}`,
        }),
      }
    )

    if (!resolveResponse.ok) {
      let errorDetails = 'Unknown error'
      try {
        const error = await resolveResponse.json()
        errorDetails = JSON.stringify(error)
      } catch {
        errorDetails = await resolveResponse.text()
      }
      console.error(
        `[provide-connected-account] Failed to resolve request: ${errorDetails}`
      )
      return c.json({ error: 'Accounts mapped but failed to notify agent' }, 500)
    }
    console.log(
      `[provide-connected-account] Request ${toolUseId} resolved successfully`
    )

    return c.json({
      success: true,
      accountsProvided: validAccounts.length,
    })
  } catch (error: unknown) {
    console.error('Failed to provide connected account:', error)
    const message = error instanceof Error ? error.message : 'Unknown error'
    return c.json(
      { error: 'Failed to provide connected account', details: message },
      500
    )
  }
})

// POST /api/agents/:id/sessions/:sessionId/answer-question - Answer or decline a question request
agents.post('/:id/sessions/:sessionId/answer-question', async (c) => {
  try {
    const agentSlug = c.req.param('id')
    const body = await c.req.json()
    const { toolUseId, answers, decline, declineReason } = body

    if (!toolUseId) {
      return c.json({ error: 'toolUseId is required' }, 400)
    }

    if (!(await agentExists(agentSlug))) {
      return c.json({ error: 'Agent not found' }, 404)
    }

    const client = containerManager.getClient(agentSlug)

    if (decline) {
      const reason = declineReason || 'User declined to answer'

      const rejectResponse = await client.fetch(
        `/inputs/${encodeURIComponent(toolUseId)}/reject`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason }),
        }
      )

      if (!rejectResponse.ok) {
        const error = await rejectResponse.json()
        console.error('Failed to reject question request:', error)
        return c.json({ error: 'Failed to reject question request' }, 500)
      }

      return c.json({ success: true, declined: true })
    }

    if (!answers || typeof answers !== 'object') {
      return c.json({ error: 'answers is required when not declining' }, 400)
    }

    // Resolve the pending input request with the answers
    console.log(`[answer-question] Resolving pending request ${toolUseId}`)
    const resolveResponse = await client.fetch(
      `/inputs/${encodeURIComponent(toolUseId)}/resolve`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: answers }),
      }
    )

    if (!resolveResponse.ok) {
      let errorDetails = 'Unknown error'
      try {
        const error = await resolveResponse.json()
        errorDetails = JSON.stringify(error)
      } catch {
        errorDetails = await resolveResponse.text()
      }
      console.error(`[answer-question] Failed to resolve request: ${errorDetails}`)
      return c.json({ error: 'Failed to submit answers' }, 500)
    }
    console.log(`[answer-question] Request ${toolUseId} resolved successfully`)

    return c.json({ success: true })
  } catch (error) {
    console.error('Failed to answer question:', error)
    return c.json({ error: 'Failed to answer question' }, 500)
  }
})

// GET /api/agents/:id/scheduled-tasks - List scheduled tasks for an agent
agents.get('/:id/scheduled-tasks', async (c) => {
  try {
    const slug = c.req.param('id')
    const status = c.req.query('status') // Optional: filter by status (e.g., 'pending')

    if (!(await agentExists(slug))) {
      return c.json({ error: 'Agent not found' }, 404)
    }

    let tasks
    if (status === 'pending') {
      tasks = await listPendingScheduledTasks(slug)
    } else {
      tasks = await listScheduledTasks(slug)
    }

    return c.json(tasks)
  } catch (error) {
    console.error('Failed to fetch scheduled tasks:', error)
    return c.json({ error: 'Failed to fetch scheduled tasks' }, 500)
  }
})

// GET /api/agents/:id/secrets - List secrets for an agent
agents.get('/:id/secrets', async (c) => {
  try {
    const slug = c.req.param('id')

    if (!(await agentExists(slug))) {
      return c.json({ error: 'Agent not found' }, 404)
    }

    const secrets = await listSecrets(slug)
    const response = secrets.map((secret) => ({
      key: secret.key,
      envVar: secret.envVar,
      hasValue: true,
    }))

    return c.json(response)
  } catch (error) {
    console.error('Failed to fetch secrets:', error)
    return c.json({ error: 'Failed to fetch secrets' }, 500)
  }
})

// POST /api/agents/:id/secrets - Create or update a secret
agents.post('/:id/secrets', async (c) => {
  try {
    const slug = c.req.param('id')
    const body = await c.req.json()
    const { key, value } = body

    if (!key?.trim()) {
      return c.json({ error: 'Key is required' }, 400)
    }

    if (value === undefined || value === null) {
      return c.json({ error: 'Value is required' }, 400)
    }

    if (!(await agentExists(slug))) {
      return c.json({ error: 'Agent not found' }, 404)
    }

    const envVar = keyToEnvVar(key.trim())

    await setSecret(slug, {
      key: key.trim(),
      envVar,
      value,
    })

    return c.json({ key: key.trim(), envVar, hasValue: true }, 201)
  } catch (error) {
    console.error('Failed to create secret:', error)
    return c.json({ error: 'Failed to create secret' }, 500)
  }
})

// PUT /api/agents/:id/secrets/:secretId - Update a secret
agents.put('/:id/secrets/:secretId', async (c) => {
  try {
    const slug = c.req.param('id')
    const envVar = c.req.param('secretId')
    const body = await c.req.json()
    const { key, value } = body

    if (!(await agentExists(slug))) {
      return c.json({ error: 'Agent not found' }, 404)
    }

    const existing = await getSecret(slug, envVar)
    if (!existing) {
      return c.json({ error: 'Secret not found' }, 404)
    }

    const newKey = key?.trim() || existing.key
    const newEnvVar = keyToEnvVar(newKey)
    const newValue = value !== undefined ? value : existing.value

    if (newEnvVar !== envVar) {
      await deleteSecret(slug, envVar)
    }

    await setSecret(slug, {
      key: newKey,
      envVar: newEnvVar,
      value: newValue,
    })

    return c.json({ key: newKey, envVar: newEnvVar, hasValue: true })
  } catch (error) {
    console.error('Failed to update secret:', error)
    return c.json({ error: 'Failed to update secret' }, 500)
  }
})

// DELETE /api/agents/:id/secrets/:secretId - Delete a secret
agents.delete('/:id/secrets/:secretId', async (c) => {
  try {
    const slug = c.req.param('id')
    const envVar = c.req.param('secretId')

    if (!(await agentExists(slug))) {
      return c.json({ error: 'Agent not found' }, 404)
    }

    const deleted = await deleteSecret(slug, envVar)

    if (!deleted) {
      return c.json({ error: 'Secret not found' }, 404)
    }

    return c.body(null, 204)
  } catch (error) {
    console.error('Failed to delete secret:', error)
    return c.json({ error: 'Failed to delete secret' }, 500)
  }
})

// GET /api/agents/:id/connected-accounts - List agent's connected accounts
agents.get('/:id/connected-accounts', async (c) => {
  try {
    const slug = c.req.param('id')

    if (!(await agentExists(slug))) {
      return c.json({ error: 'Agent not found' }, 404)
    }

    const mappings = await db
      .select({
        mapping: agentConnectedAccounts,
        account: connectedAccounts,
      })
      .from(agentConnectedAccounts)
      .innerJoin(
        connectedAccounts,
        eq(agentConnectedAccounts.connectedAccountId, connectedAccounts.id)
      )
      .where(eq(agentConnectedAccounts.agentSlug, slug))

    const accounts = mappings.map(({ mapping, account }) => ({
      ...account,
      mappingId: mapping.id,
      mappedAt: mapping.createdAt,
      provider: getProvider(account.toolkitSlug),
    }))

    return c.json({ accounts })
  } catch (error) {
    console.error('Failed to fetch agent connected accounts:', error)
    return c.json({ error: 'Failed to fetch agent connected accounts' }, 500)
  }
})

// POST /api/agents/:id/connected-accounts - Map account(s) to agent
agents.post('/:id/connected-accounts', async (c) => {
  try {
    const slug = c.req.param('id')
    const body = await c.req.json()
    const { accountIds } = body as { accountIds: string[] }

    if (!accountIds || !Array.isArray(accountIds) || accountIds.length === 0) {
      return c.json(
        { error: 'Missing required field: accountIds (array)' },
        400
      )
    }

    if (!(await agentExists(slug))) {
      return c.json({ error: 'Agent not found' }, 404)
    }

    const now = new Date()
    const newMappings = accountIds.map((accountId) => ({
      id: crypto.randomUUID(),
      agentSlug: slug,
      connectedAccountId: accountId,
      createdAt: now,
    }))

    for (const mapping of newMappings) {
      try {
        await db.insert(agentConnectedAccounts).values(mapping)
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : ''
        if (!message.includes('UNIQUE constraint failed')) {
          throw error
        }
      }
    }

    const updatedMappings = await db
      .select({
        mapping: agentConnectedAccounts,
        account: connectedAccounts,
      })
      .from(agentConnectedAccounts)
      .innerJoin(
        connectedAccounts,
        eq(agentConnectedAccounts.connectedAccountId, connectedAccounts.id)
      )
      .where(eq(agentConnectedAccounts.agentSlug, slug))

    const accounts = updatedMappings.map(({ mapping, account }) => ({
      ...account,
      mappingId: mapping.id,
      mappedAt: mapping.createdAt,
      provider: getProvider(account.toolkitSlug),
    }))

    return c.json({ accounts })
  } catch (error) {
    console.error('Failed to map connected accounts to agent:', error)
    return c.json({ error: 'Failed to map connected accounts to agent' }, 500)
  }
})

// DELETE /api/agents/:id/connected-accounts/:accountId - Remove account mapping from agent
agents.delete('/:id/connected-accounts/:accountId', async (c) => {
  try {
    const slug = c.req.param('id')
    const accountId = c.req.param('accountId')

    const filtered = await db
      .select()
      .from(agentConnectedAccounts)
      .where(eq(agentConnectedAccounts.agentSlug, slug))

    const found = filtered.find((m) => m.connectedAccountId === accountId)

    if (!found) {
      return c.json({ error: 'Account mapping not found' }, 404)
    }

    await db
      .delete(agentConnectedAccounts)
      .where(eq(agentConnectedAccounts.id, found.id))

    return c.body(null, 204)
  } catch (error) {
    console.error('Failed to remove account mapping:', error)
    return c.json({ error: 'Failed to remove account mapping' }, 500)
  }
})

// GET /api/agents/:id/skills - Get skills for an agent
agents.get('/:id/skills', async (c) => {
  try {
    const id = c.req.param('id')
    const skills = await getAgentSkills(id)
    return c.json({ skills })
  } catch (error) {
    console.error('Failed to fetch skills:', error)
    return c.json({ error: 'Failed to fetch skills' }, 500)
  }
})

// GET /api/agents/:id/audit-log - Get proxy audit log for agent
agents.get('/:id/audit-log', async (c) => {
  try {
    const slug = c.req.param('id')

    if (!(await agentExists(slug))) {
      return c.json({ error: 'Agent not found' }, 404)
    }

    const offset = parseInt(c.req.query('offset') ?? '0', 10)
    const limit = Math.min(parseInt(c.req.query('limit') ?? '20', 10), 100)

    const [entries, totalResult] = await Promise.all([
      db
        .select()
        .from(proxyAuditLog)
        .where(eq(proxyAuditLog.agentSlug, slug))
        .orderBy(desc(proxyAuditLog.createdAt))
        .limit(limit)
        .offset(offset),
      db
        .select({ count: count() })
        .from(proxyAuditLog)
        .where(eq(proxyAuditLog.agentSlug, slug)),
    ])

    return c.json({ entries, total: totalResult[0].count })
  } catch (error) {
    console.error('Failed to fetch audit log:', error)
    return c.json({ error: 'Failed to fetch audit log' }, 500)
  }
})

// Shared upload logic - writes file to agent workspace
async function handleFileUpload(agentSlug: string, file: File) {
  const filename = file.name
  const uploadPath = `uploads/${Date.now()}-${filename}`
  const arrayBuffer = await file.arrayBuffer()
  const buffer = Buffer.from(arrayBuffer)

  // Write directly to host filesystem (volume-mounted into container)
  const workspaceDir = getAgentWorkspaceDir(agentSlug)
  const fullPath = path.join(workspaceDir, uploadPath)
  await fs.promises.mkdir(path.dirname(fullPath), { recursive: true })
  await fs.promises.writeFile(fullPath, buffer)

  return {
    success: true,
    path: `/workspace/${uploadPath}`,
    filename,
    size: buffer.byteLength,
  }
}

// POST /api/agents/:id/upload-file - Upload a file to the agent workspace (no session required)
agents.post('/:id/upload-file', async (c) => {
  try {
    const agentSlug = c.req.param('id')

    if (!(await agentExists(agentSlug))) {
      return c.json({ error: 'Agent not found' }, 404)
    }

    const formData = await c.req.formData()
    const file = formData.get('file') as File | null

    if (!file) {
      return c.json({ error: 'No file provided' }, 400)
    }

    const result = await handleFileUpload(agentSlug, file)
    return c.json(result)
  } catch (error) {
    console.error('Failed to upload file:', error)
    return c.json({ error: 'Failed to upload file' }, 500)
  }
})

// POST /api/agents/:id/sessions/:sessionId/upload-file - Upload a file to the agent workspace
agents.post('/:id/sessions/:sessionId/upload-file', async (c) => {
  try {
    const agentSlug = c.req.param('id')

    if (!(await agentExists(agentSlug))) {
      return c.json({ error: 'Agent not found' }, 404)
    }

    const formData = await c.req.formData()
    const file = formData.get('file') as File | null

    if (!file) {
      return c.json({ error: 'No file provided' }, 400)
    }

    const result = await handleFileUpload(agentSlug, file)
    return c.json(result)
  } catch (error) {
    console.error('Failed to upload file:', error)
    return c.json({ error: 'Failed to upload file' }, 500)
  }
})

// GET /api/agents/:id/files/* - Download a file from the agent workspace
agents.get('/:id/files/*', async (c) => {
  try {
    const agentSlug = c.req.param('id')
    // Extract file path from URL - wildcard param can be unreliable in sub-routers
    const urlPath = new URL(c.req.url).pathname
    const filesPrefix = `/api/agents/${agentSlug}/files/`
    const filePath = urlPath.startsWith(filesPrefix)
      ? decodeURIComponent(urlPath.slice(filesPrefix.length))
      : ''

    if (!filePath) {
      return c.json({ error: 'File path is required' }, 400)
    }

    if (!(await agentExists(agentSlug))) {
      return c.json({ error: 'Agent not found' }, 404)
    }

    const workspaceDir = getAgentWorkspaceDir(agentSlug)
    const fullPath = path.resolve(workspaceDir, filePath)

    // Security: ensure path doesn't escape workspace
    if (!fullPath.startsWith(workspaceDir)) {
      return c.json({ error: 'Invalid path' }, 400)
    }

    const stat = await fs.promises.stat(fullPath).catch(() => null)
    if (!stat || !stat.isFile()) {
      return c.json({ error: 'File not found' }, 404)
    }

    const buffer = await fs.promises.readFile(fullPath)
    const filename = path.basename(filePath)

    c.header('Content-Disposition', `attachment; filename="${filename}"`)
    c.header('Content-Type', 'application/octet-stream')
    c.header('Content-Length', buffer.byteLength.toString())

    return c.body(buffer)
  } catch (error) {
    console.error('Failed to download file:', error)
    return c.json({ error: 'Failed to download file' }, 500)
  }
})

// POST /api/agents/:id/sessions/:sessionId/provide-file - Provide or decline a file request
agents.post('/:id/sessions/:sessionId/provide-file', async (c) => {
  try {
    const agentSlug = c.req.param('id')
    const body = await c.req.json()
    const { toolUseId, filePath, decline, declineReason } = body

    if (!toolUseId) {
      return c.json({ error: 'toolUseId is required' }, 400)
    }

    if (!(await agentExists(agentSlug))) {
      return c.json({ error: 'Agent not found' }, 404)
    }

    const client = containerManager.getClient(agentSlug)

    if (decline) {
      const reason = declineReason || 'User declined to provide the file'

      const rejectResponse = await client.fetch(
        `/inputs/${encodeURIComponent(toolUseId)}/reject`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason }),
        }
      )

      if (!rejectResponse.ok) {
        const error = await rejectResponse.json()
        console.error('Failed to reject file request:', error)
        return c.json({ error: 'Failed to reject file request' }, 500)
      }

      return c.json({ success: true, declined: true })
    }

    if (!filePath) {
      return c.json({ error: 'filePath is required when not declining' }, 400)
    }

    // Resolve the pending input request with the file path
    console.log(`[provide-file] Resolving pending request ${toolUseId} with path ${filePath}`)
    const resolveResponse = await client.fetch(
      `/inputs/${encodeURIComponent(toolUseId)}/resolve`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: filePath }),
      }
    )

    if (!resolveResponse.ok) {
      let errorDetails = 'Unknown error'
      try {
        const error = await resolveResponse.json()
        errorDetails = JSON.stringify(error)
      } catch {
        errorDetails = await resolveResponse.text()
      }
      console.error(`[provide-file] Failed to resolve request: ${errorDetails}`)
      return c.json({ error: 'Failed to notify agent of uploaded file' }, 500)
    }
    console.log(`[provide-file] Request ${toolUseId} resolved successfully`)

    return c.json({ success: true, filePath })
  } catch (error) {
    console.error('Failed to provide file:', error)
    return c.json({ error: 'Failed to provide file' }, 500)
  }
})

export default agents
