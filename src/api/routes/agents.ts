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
  getSessionMessagesWithCompact,
  getSession,
  getSessionMetadata,
  deleteSession,
  removeMessage,
  removeToolCall,
} from '@shared/lib/services/session-service'
import { getSessionJsonlPath, readFileOrNull, getAgentSessionsDir, readJsonlFile } from '@shared/lib/utils/file-storage'
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
import { connectedAccounts, agentConnectedAccounts, proxyAuditLog, remoteMcpServers, agentRemoteMcps, mcpAuditLog } from '@shared/lib/db/schema'
import { eq, and, inArray, desc, count } from 'drizzle-orm'
import { getProvider } from '@shared/lib/composio/providers'
// getAgentSkills is superseded by getAgentSkillsWithStatus from skillset-service
// import { getAgentSkills } from '@shared/lib/skills'
import {
  getAgentSkillsWithStatus,
  getDiscoverableSkills,
  installSkillFromSkillset,
  updateSkillFromSkillset,
  createSkillPR,
  getSkillPRInfo,
  getSkillPublishInfo,
  publishSkillToSkillset,
  refreshAgentSkills,
} from '@shared/lib/services/skillset-service'
import { listArtifactsFromFilesystem } from '@shared/lib/services/artifact-service'
import { getContainerHostUrl, getAppPort } from '@shared/lib/proxy/host-url'
import {
  exportAgentTemplate,
  importAgentFromTemplate,
  installAgentFromSkillset,
  updateAgentFromSkillset,
  getAgentTemplateStatus,
  getDiscoverableAgents,
  refreshSkillsetCaches,
  getAgentPRInfo,
  createAgentPR,
  getAgentPublishInfo,
  publishAgentToSkillset,
  refreshAgentTemplates,
  hasOnboardingSkill,
} from '@shared/lib/services/agent-template-service'
import { withRetry } from '@shared/lib/utils/retry'
import { transformMessages } from '@shared/lib/utils/message-transform'
import { getEffectiveAnthropicApiKey, getEffectiveModels, getEffectiveAgentLimits, getCustomEnvVars, getSettings } from '@shared/lib/config/settings'
import { revokeProxyToken } from '@shared/lib/proxy/token-store'
import { getAgentWorkspaceDir } from '@shared/lib/utils/file-storage'
import * as fs from 'fs'
import { Readable } from 'stream'
import * as path from 'path'

const agents = new Hono()

// ============================================================
// Routes that must be registered BEFORE /:id middleware
// (paths like /import-template would otherwise match as :id)
// ============================================================

// POST /api/agents/import-template - Import agent from uploaded ZIP
agents.post('/import-template', async (c) => {
  try {
    const formData = await c.req.formData()
    const file = formData.get('file') as File | null
    const nameOverride = formData.get('name') as string | null

    if (!file) {
      return c.json({ error: 'No file provided' }, 400)
    }

    const arrayBuffer = await file.arrayBuffer()
    const zipBuffer = Buffer.from(arrayBuffer)

    const agent = await importAgentFromTemplate(zipBuffer, nameOverride || undefined)
    const hasOnboarding = await hasOnboardingSkill(agent.slug)
    return c.json({ ...agent, hasOnboarding }, 201)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to import template'
    console.error('Failed to import template:', error)
    return c.json({ error: message }, 500)
  }
})

// GET /api/agents/discoverable-agents - List agents available from skillsets
// Uses ?refresh=true to force a cache refresh before reading
agents.get('/discoverable-agents', async (c) => {
  try {
    const { skillsets } = getSettings()
    const ssArray = skillsets || []
    const shouldRefresh = c.req.query('refresh') === 'true'

    if (shouldRefresh) {
      await refreshSkillsetCaches(ssArray)
    }

    const discoverableAgents = await getDiscoverableAgents(ssArray)
    return c.json({ agents: discoverableAgents })
  } catch (error) {
    console.error('Failed to fetch discoverable agents:', error)
    return c.json({ error: 'Failed to fetch discoverable agents' }, 500)
  }
})

// POST /api/agents/install-from-skillset - Install agent from skillset
agents.post('/install-from-skillset', async (c) => {
  try {
    const { skillsetId, agentPath, agentName, agentVersion } = await c.req.json()

    if (!skillsetId || !agentPath) {
      return c.json({ error: 'skillsetId and agentPath are required' }, 400)
    }

    const { skillsets } = getSettings()
    const config = (skillsets || []).find((s: any) => s.id === skillsetId)
    if (!config) {
      return c.json({ error: 'Skillset not found' }, 404)
    }

    const agent = await installAgentFromSkillset(
      skillsetId,
      config.url,
      agentPath,
      agentName || agentPath,
      agentVersion || '0.0.0',
    )

    const hasOnboarding = await hasOnboardingSkill(agent.slug)
    return c.json({ ...agent, hasOnboarding }, 201)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to install agent from skillset'
    console.error('Failed to install agent from skillset:', error)
    return c.json({ error: message }, 500)
  }
})

// Middleware: verify agent exists for all /:id/* routes
agents.use('/:id/*', async (c, next) => {
  const slug = c.req.param('id')
  if (!(await agentExists(slug))) {
    return c.json({ error: 'Agent not found' }, 404)
  }
  await next()
})

// Create Anthropic client lazily to use API key from settings
function getAnthropicClient(): Anthropic {
  const apiKey = getEffectiveAnthropicApiKey()
  if (!apiKey) {
    throw new Error('Anthropic API key not configured')
  }
  return new Anthropic({ apiKey })
}

// Model used for generating session names (lightweight task)
function getSummarizerModel(): string {
  return getEffectiveModels().summarizerModel
}

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
        model: getSummarizerModel(),
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


    await containerManager.ensureRunning(slug)
    const agent = await getAgentWithStatus(slug)

    // Note: agent_status_changed is broadcast by containerManager.ensureRunning()

    return c.json(agent)
  } catch (error) {
    console.error('Failed to start agent:', error)
    const message = error instanceof Error ? error.message : 'Failed to start agent'
    return c.json({ error: message }, 500)
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

    // Use cached status to avoid spawning docker process
    const info = containerManager.getCachedInfo(slug)

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

    await containerManager.stopContainer(slug)

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

    const agentLimits = getEffectiveAgentLimits()
    const customEnvVars = getCustomEnvVars()
    const containerSession = await client.createSession({
      availableEnvVars: availableEnvVars.length > 0 ? availableEnvVars : undefined,
      initialMessage: message.trim(),
      model: getEffectiveModels().agentModel,
      browserModel: getEffectiveModels().browserModel,
      maxOutputTokens: agentLimits.maxOutputTokens,
      maxThinkingTokens: agentLimits.maxThinkingTokens,
      maxTurns: agentLimits.maxTurns,
      maxBudgetUsd: agentLimits.maxBudgetUsd,
      customEnvVars: Object.keys(customEnvVars).length > 0 ? customEnvVars : undefined,
    })
    const sessionId = containerSession.id

    await registerSession(slug, sessionId, 'New Session')
    await messagePersister.subscribeToSession(sessionId, client, sessionId, slug)
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


    const messages = await getSessionMessagesWithCompact(agentSlug, sessionId)
    const filtered = messages.filter((m) => !('isMeta' in m && m.isMeta))
    const transformed = transformMessages(filtered)

    return c.json(transformed)
  } catch (error) {
    console.error('Failed to fetch messages:', error)
    return c.json({ error: 'Failed to fetch messages' }, 500)
  }
})

// DELETE /api/agents/:id/sessions/:sessionId/messages/:messageId - Remove a message from history
agents.delete('/:id/sessions/:sessionId/messages/:messageId', async (c) => {
  try {
    const agentSlug = c.req.param('id')
    const sessionId = c.req.param('sessionId')
    const messageId = c.req.param('messageId')


    const removed = await removeMessage(agentSlug, sessionId, messageId)
    if (!removed) {
      return c.json({ error: 'Message not found' }, 404)
    }

    return c.body(null, 204)
  } catch (error) {
    console.error('Failed to remove message:', error)
    return c.json({ error: 'Failed to remove message' }, 500)
  }
})

// DELETE /api/agents/:id/sessions/:sessionId/tool-calls/:toolCallId - Remove a tool call from history
agents.delete('/:id/sessions/:sessionId/tool-calls/:toolCallId', async (c) => {
  try {
    const agentSlug = c.req.param('id')
    const sessionId = c.req.param('sessionId')
    const toolCallId = c.req.param('toolCallId')


    const removed = await removeToolCall(agentSlug, sessionId, toolCallId)
    if (!removed) {
      return c.json({ error: 'Tool call not found' }, 404)
    }

    return c.body(null, 204)
  } catch (error) {
    console.error('Failed to remove tool call:', error)
    return c.json({ error: 'Failed to remove tool call' }, 500)
  }
})

// GET /api/agents/:id/sessions/:sessionId/subagent/:agentId/messages - Get subagent messages
agents.get('/:id/sessions/:sessionId/subagent/:agentId/messages', async (c) => {
  try {
    const agentSlug = c.req.param('id')
    const sessionId = c.req.param('sessionId')
    const subagentId = c.req.param('agentId')

    const sessionsDir = getAgentSessionsDir(agentSlug)
    const subagentJsonlPath = path.join(sessionsDir, sessionId, 'subagents', `agent-${subagentId}.jsonl`)

    const entries = await readJsonlFile(subagentJsonlPath) as any[]
    const messageEntries = entries.filter(
      (e) => e.type === 'user' || e.type === 'assistant'
    )
    const transformed = transformMessages(messageEntries)
    return c.json(transformed)
  } catch (error) {
    console.error('Failed to fetch subagent messages:', error)
    return c.json({ error: 'Failed to fetch subagent messages' }, 500)
  }
})

// GET /api/agents/:id/sessions/:sessionId/raw-log - Get raw JSONL log for a session
agents.get('/:id/sessions/:sessionId/raw-log', async (c) => {
  try {
    const agentSlug = c.req.param('id')
    const sessionId = c.req.param('sessionId')


    const jsonlPath = getSessionJsonlPath(agentSlug, sessionId)
    const content = await readFileOrNull(jsonlPath)

    if (content === null) {
      return c.json({ error: 'Session log not found' }, 404)
    }

    return c.text(content)
  } catch (error) {
    console.error('Failed to fetch raw log:', error)
    return c.json({ error: 'Failed to fetch raw log' }, 500)
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
    // Use cached status to avoid spawning docker process
    let info = containerManager.getCachedInfo(agentSlug)

    if (info.status !== 'running') {
      await containerManager.ensureRunning(agentSlug)
      // ensureRunning updates the cache, so get updated info
      info = containerManager.getCachedInfo(agentSlug)
    }

    if (!messagePersister.isSubscribed(sessionId)) {
      await messagePersister.subscribeToSession(sessionId, client, sessionId, agentSlug)
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


    const session = await getSession(agentSlug, sessionId)

    if (!session) {
      return c.json({ error: 'Session not found' }, 404)
    }

    const isActive = messagePersister.isSessionActive(sessionId)
    const metadata = await getSessionMetadata(agentSlug, sessionId)

    return c.json({
      id: session.id,
      agentSlug: session.agentSlug,
      name: session.name,
      createdAt: session.createdAt,
      lastActivityAt: session.lastActivityAt,
      messageCount: session.messageCount,
      isActive,
      lastUsage: metadata?.lastUsage,
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


    const client = containerManager.getClient(agentSlug)
    // Use cached status to avoid spawning docker process
    const info = containerManager.getCachedInfo(agentSlug)

    // If container isn't running, just mark the session as interrupted locally
    // This handles the case where container crashed/restarted but UI still shows active
    if (info.status !== 'running') {
      console.log(`[Agents] Container not running for ${agentSlug}, marking session ${sessionId} as interrupted locally`)
      await messagePersister.markSessionInterrupted(sessionId)
      return c.json({ success: true, note: 'Container not running, session marked inactive' })
    }

    // Try to interrupt in the container
    const interrupted = await client.interruptSession(sessionId)

    // Even if container interrupt fails (session might not exist there anymore),
    // still mark it as interrupted locally to update the UI
    if (!interrupted) {
      console.log(`[Agents] Container interrupt returned false for session ${sessionId}, marking as interrupted locally`)
    }

    await messagePersister.markSessionInterrupted(sessionId)

    return c.json({ success: true })
  } catch (error) {
    console.error('Failed to interrupt session:', error)
    // Even on error, try to mark session as interrupted to fix UI state
    try {
      const sessionId = c.req.param('sessionId')
      await messagePersister.markSessionInterrupted(sessionId)
      return c.json({ success: true, note: 'Error during interrupt, but session marked inactive' })
    } catch {
      return c.json({ error: 'Failed to interrupt session' }, 500)
    }
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

// GET /api/agents/:id/remote-mcps - List remote MCP servers assigned to this agent
agents.get('/:id/remote-mcps', async (c) => {
  try {
    const slug = c.req.param('id')
    const mappings = await db
      .select({ mcp: remoteMcpServers, mapping: agentRemoteMcps })
      .from(agentRemoteMcps)
      .innerJoin(
        remoteMcpServers,
        eq(agentRemoteMcps.remoteMcpId, remoteMcpServers.id)
      )
      .where(eq(agentRemoteMcps.agentSlug, slug))

    return c.json({
      mcps: mappings.map(({ mcp, mapping }) => ({
        id: mcp.id,
        name: mcp.name,
        url: mcp.url,
        authType: mcp.authType,
        status: mcp.status,
        errorMessage: mcp.errorMessage,
        tools: mcp.toolsJson ? JSON.parse(mcp.toolsJson) : [],
        mappingId: mapping.id,
        mappedAt: mapping.createdAt,
      })),
    })
  } catch (error) {
    console.error('Failed to fetch agent remote MCPs:', error)
    return c.json({ error: 'Failed to fetch agent remote MCPs' }, 500)
  }
})

// POST /api/agents/:id/remote-mcps - Assign remote MCP server(s) to agent
agents.post('/:id/remote-mcps', async (c) => {
  try {
    const slug = c.req.param('id')
    const body = await c.req.json<{ mcpIds: string[] }>()

    if (!Array.isArray(body.mcpIds) || body.mcpIds.length === 0) {
      return c.json({ error: 'mcpIds array is required' }, 400)
    }

    const now = new Date()
    const values = body.mcpIds.map((mcpId) => ({
      id: crypto.randomUUID(),
      agentSlug: slug,
      remoteMcpId: mcpId,
      createdAt: now,
    }))

    await db.insert(agentRemoteMcps).values(values).onConflictDoNothing()

    return c.json({ success: true, added: values.length })
  } catch (error) {
    console.error('Failed to assign remote MCPs to agent:', error)
    return c.json({ error: 'Failed to assign remote MCPs to agent' }, 500)
  }
})

// DELETE /api/agents/:id/remote-mcps/:mcpId - Remove remote MCP from agent
agents.delete('/:id/remote-mcps/:mcpId', async (c) => {
  try {
    const slug = c.req.param('id')
    const mcpId = c.req.param('mcpId')

    const [mapping] = await db
      .select()
      .from(agentRemoteMcps)
      .where(
        and(
          eq(agentRemoteMcps.agentSlug, slug),
          eq(agentRemoteMcps.remoteMcpId, mcpId)
        )
      )
      .limit(1)

    if (!mapping) {
      return c.json({ error: 'MCP mapping not found' }, 404)
    }

    await db.delete(agentRemoteMcps).where(eq(agentRemoteMcps.id, mapping.id))
    return c.body(null, 204)
  } catch (error) {
    console.error('Failed to remove remote MCP from agent:', error)
    return c.json({ error: 'Failed to remove remote MCP from agent' }, 500)
  }
})

// POST /api/agents/:id/sessions/:sessionId/provide-remote-mcp - Handle user approval of runtime MCP request
agents.post('/:id/sessions/:sessionId/provide-remote-mcp', async (c) => {
  try {
    const slug = c.req.param('id')
    const body = await c.req.json<{
      toolUseId: string
      remoteMcpId: string
      decline?: boolean
      declineReason?: string
    }>()

    if (!body.toolUseId) {
      return c.json({ error: 'toolUseId is required' }, 400)
    }
    if (!body.decline && !body.remoteMcpId) {
      return c.json({ error: 'remoteMcpId is required when not declining' }, 400)
    }

    const client = containerManager.getClient(slug)

    if (body.decline) {
      // Decline the request
      const rejectResponse = await client.fetch(`/inputs/${encodeURIComponent(body.toolUseId)}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reason: body.declineReason || 'User declined to provide MCP access',
        }),
      })
      if (!rejectResponse.ok) {
        console.error('Failed to reject remote MCP request:', await rejectResponse.text())
        return c.json({ error: 'Failed to decline the request in container' }, 502)
      }
      return c.json({ success: true, status: 'declined' })
    }

    // Map MCP to agent if not already mapped
    const existingMapping = await db
      .select()
      .from(agentRemoteMcps)
      .where(
        and(
          eq(agentRemoteMcps.agentSlug, slug),
          eq(agentRemoteMcps.remoteMcpId, body.remoteMcpId)
        )
      )
      .limit(1)

    if (existingMapping.length === 0) {
      await db.insert(agentRemoteMcps).values({
        id: crypto.randomUUID(),
        agentSlug: slug,
        remoteMcpId: body.remoteMcpId,
        createdAt: new Date(),
      })
    }

    // Fetch updated remote MCPs for this agent
    const hostUrl = getContainerHostUrl()
    const appPort = getAppPort()
    const mcpMappings = await db
      .select({ mcp: remoteMcpServers })
      .from(agentRemoteMcps)
      .innerJoin(remoteMcpServers, eq(agentRemoteMcps.remoteMcpId, remoteMcpServers.id))
      .where(eq(agentRemoteMcps.agentSlug, slug))

    const mcpConfigs = mcpMappings
      .filter(({ mcp }) => mcp.status === 'active')
      .map(({ mcp }) => ({
        id: mcp.id,
        name: mcp.name,
        proxyUrl: `http://${hostUrl}:${appPort}/api/mcp-proxy/${slug}/${mcp.id}`,
        tools: mcp.toolsJson ? JSON.parse(mcp.toolsJson) : [],
      }))

    // Update container env var
    const envResponse = await client.fetch('/env', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'REMOTE_MCPS', value: JSON.stringify(mcpConfigs) }),
    })
    if (!envResponse.ok) {
      console.error('Failed to update REMOTE_MCPS env var:', await envResponse.text())
      return c.json({ error: 'Failed to update container environment' }, 502)
    }

    // Resolve the pending input request
    const resolveResponse = await client.fetch(`/inputs/${encodeURIComponent(body.toolUseId)}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: body.remoteMcpId }),
    })
    if (!resolveResponse.ok) {
      console.error('Failed to resolve remote MCP request:', await resolveResponse.text())
      return c.json({ error: 'Failed to resolve the request in container' }, 502)
    }

    return c.json({ success: true, status: 'provided' })
  } catch (error) {
    console.error('Failed to provide remote MCP:', error)
    return c.json({ error: 'Failed to provide remote MCP' }, 500)
  }
})

// GET /api/agents/:id/mcp-audit-log - Get MCP audit log for an agent
agents.get('/:id/mcp-audit-log', async (c) => {
  try {
    const slug = c.req.param('id')
    const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 100)
    const offset = parseInt(c.req.query('offset') || '0', 10)

    const entries = await db
      .select()
      .from(mcpAuditLog)
      .where(eq(mcpAuditLog.agentSlug, slug))
      .orderBy(desc(mcpAuditLog.createdAt))
      .limit(limit)
      .offset(offset)

    const [totalResult] = await db
      .select({ count: count() })
      .from(mcpAuditLog)
      .where(eq(mcpAuditLog.agentSlug, slug))

    return c.json({
      entries,
      total: totalResult?.count || 0,
      limit,
      offset,
    })
  } catch (error) {
    console.error('Failed to fetch MCP audit log:', error)
    return c.json({ error: 'Failed to fetch MCP audit log' }, 500)
  }
})

// GET /api/agents/:id/skills - Get skills for an agent (with status info)
agents.get('/:id/skills', async (c) => {
  try {
    const id = c.req.param('id')
    const { skillsets } = getSettings()
    const skills = await getAgentSkillsWithStatus(id, skillsets || [])
    return c.json({ skills })
  } catch (error) {
    console.error('Failed to fetch skills:', error)
    return c.json({ error: 'Failed to fetch skills' }, 500)
  }
})

// GET /api/agents/:id/discoverable-skills - Get available skills from skillsets
agents.get('/:id/discoverable-skills', async (c) => {
  try {
    const id = c.req.param('id')
    const { skillsets } = getSettings()
    const skills = await getDiscoverableSkills(id, skillsets || [])
    return c.json({ skills })
  } catch (error) {
    console.error('Failed to fetch discoverable skills:', error)
    return c.json({ error: 'Failed to fetch discoverable skills' }, 500)
  }
})

// POST /api/agents/:id/skills/install - Install a skill from a skillset
agents.post('/:id/skills/install', async (c) => {
  try {
    const agentSlug = c.req.param('id')
    const { skillsetId, skillPath, skillName, skillVersion, envVars } = await c.req.json()

    if (!skillsetId || !skillPath) {
      return c.json({ error: 'skillsetId and skillPath are required' }, 400)
    }

    // Find the skillset config
    const { skillsets } = getSettings()
    const config = (skillsets || []).find((s) => s.id === skillsetId)
    if (!config) {
      return c.json({ error: 'Skillset not found' }, 404)
    }

    const result = await installSkillFromSkillset(
      agentSlug,
      skillsetId,
      config.url,
      skillPath,
      skillName || skillPath,
      skillVersion || '0.0.0',
    )

    // If env vars were provided, save them as agent secrets
    if (envVars && typeof envVars === 'object') {
      for (const [envVar, value] of Object.entries(envVars)) {
        if (value && typeof value === 'string') {
          await setSecret(agentSlug, { key: envVar, envVar, value })
        }
      }
    }

    return c.json({ installed: true, ...result })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to install skill'
    console.error('Failed to install skill:', error)
    return c.json({ error: message }, 500)
  }
})

// POST /api/agents/:id/skills/:dir/update - Update an installed skill
agents.post('/:id/skills/:dir/update', async (c) => {
  try {
    const agentSlug = c.req.param('id')
    const skillDir = c.req.param('dir')
    const result = await updateSkillFromSkillset(agentSlug, skillDir)
    return c.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update skill'
    console.error('Failed to update skill:', error)
    return c.json({ error: message }, 500)
  }
})

// GET /api/agents/:id/skills/:dir/pr-info - Get info for PR dialog
agents.get('/:id/skills/:dir/pr-info', async (c) => {
  try {
    const agentSlug = c.req.param('id')
    const skillDir = c.req.param('dir')
    const info = await getSkillPRInfo(agentSlug, skillDir)
    return c.json(info)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to get PR info'
    console.error('Failed to get PR info:', error)
    return c.json({ error: message }, 500)
  }
})

// POST /api/agents/:id/skills/:dir/create-pr - Create PR for local changes
agents.post('/:id/skills/:dir/create-pr', async (c) => {
  try {
    const agentSlug = c.req.param('id')
    const skillDir = c.req.param('dir')
    const { title, body, newVersion } = await c.req.json()

    if (!title || !body) {
      return c.json({ error: 'title and body are required' }, 400)
    }

    const result = await createSkillPR(agentSlug, skillDir, { title, body, newVersion })
    return c.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create PR'
    console.error('Failed to create PR:', error)
    return c.json({ error: message }, 500)
  }
})

// GET /api/agents/:id/skills/:dir/publish-info - Get info for publishing a local skill
agents.get('/:id/skills/:dir/publish-info', async (c) => {
  try {
    const agentSlug = c.req.param('id')
    const skillDir = c.req.param('dir')
    const skillsetId = c.req.query('skillsetId')

    if (!skillsetId) {
      return c.json({ error: 'skillsetId query parameter is required' }, 400)
    }

    const settings = getSettings()
    const config = (settings.skillsets || []).find((s) => s.id === skillsetId)
    if (!config) {
      return c.json({ error: 'Skillset not found' }, 404)
    }

    const info = await getSkillPublishInfo(agentSlug, skillDir, config)
    return c.json(info)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to get publish info'
    console.error('Failed to get publish info:', error)
    return c.json({ error: message }, 500)
  }
})

// POST /api/agents/:id/skills/:dir/publish - Publish a local skill to a skillset
agents.post('/:id/skills/:dir/publish', async (c) => {
  try {
    const agentSlug = c.req.param('id')
    const skillDir = c.req.param('dir')
    const { skillsetId, title, body, newVersion } = await c.req.json()

    if (!skillsetId || !title || !body) {
      return c.json({ error: 'skillsetId, title, and body are required' }, 400)
    }

    const settings = getSettings()
    const config = (settings.skillsets || []).find((s) => s.id === skillsetId)
    if (!config) {
      return c.json({ error: 'Skillset not found' }, 404)
    }

    const result = await publishSkillToSkillset(agentSlug, skillDir, config, {
      title, body, newVersion,
    })
    return c.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to publish skill'
    console.error('Failed to publish skill:', error)
    return c.json({ error: message }, 500)
  }
})

// ============================================================
// Agent Template endpoints
// ============================================================

// POST /api/agents/:id/export-template - Export agent as ZIP download
agents.post('/:id/export-template', async (c) => {
  try {
    const slug = c.req.param('id')
    const zipBuffer = await exportAgentTemplate(slug)

    return new Response(new Uint8Array(zipBuffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${slug}-template.zip"`,
        'Content-Length': zipBuffer.byteLength.toString(),
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to export template'
    console.error('Failed to export template:', error)
    return c.json({ error: message }, 500)
  }
})

// GET /api/agents/:id/template-status - Get skillset status
agents.get('/:id/template-status', async (c) => {
  try {
    const slug = c.req.param('id')
    const { skillsets } = getSettings()
    const status = await getAgentTemplateStatus(slug, skillsets || [])
    return c.json(status)
  } catch (error) {
    console.error('Failed to get template status:', error)
    return c.json({ error: 'Failed to get template status' }, 500)
  }
})

// POST /api/agents/:id/template-update - Update from skillset
agents.post('/:id/template-update', async (c) => {
  try {
    const slug = c.req.param('id')
    const result = await updateAgentFromSkillset(slug)
    return c.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update template'
    console.error('Failed to update template:', error)
    return c.json({ error: message }, 500)
  }
})

// GET /api/agents/:id/template-pr-info - Get AI-suggested PR info
agents.get('/:id/template-pr-info', async (c) => {
  try {
    const slug = c.req.param('id')
    const info = await getAgentPRInfo(slug)
    return c.json(info)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to get PR info'
    console.error('Failed to get template PR info:', error)
    return c.json({ error: message }, 500)
  }
})

// POST /api/agents/:id/template-create-pr - Create PR for modifications
agents.post('/:id/template-create-pr', async (c) => {
  try {
    const slug = c.req.param('id')
    const { title, body, newVersion } = await c.req.json()

    if (!title || !body) {
      return c.json({ error: 'title and body are required' }, 400)
    }

    const result = await createAgentPR(slug, { title, body, newVersion })
    return c.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create PR'
    console.error('Failed to create template PR:', error)
    return c.json({ error: message }, 500)
  }
})

// GET /api/agents/:id/template-publish-info - Get publish info
agents.get('/:id/template-publish-info', async (c) => {
  try {
    const slug = c.req.param('id')
    const skillsetId = c.req.query('skillsetId')

    if (!skillsetId) {
      return c.json({ error: 'skillsetId query parameter is required' }, 400)
    }

    const settings = getSettings()
    const config = (settings.skillsets || []).find((s) => s.id === skillsetId)
    if (!config) {
      return c.json({ error: 'Skillset not found' }, 404)
    }

    const info = await getAgentPublishInfo(slug, config)
    return c.json(info)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to get publish info'
    console.error('Failed to get template publish info:', error)
    return c.json({ error: message }, 500)
  }
})

// POST /api/agents/:id/template-publish - Publish to skillset
agents.post('/:id/template-publish', async (c) => {
  try {
    const slug = c.req.param('id')
    const { skillsetId, title, body, newVersion } = await c.req.json()

    if (!skillsetId || !title || !body) {
      return c.json({ error: 'skillsetId, title, and body are required' }, 400)
    }

    const settings = getSettings()
    const config = (settings.skillsets || []).find((s) => s.id === skillsetId)
    if (!config) {
      return c.json({ error: 'Skillset not found' }, 404)
    }

    const result = await publishAgentToSkillset(slug, config, { title, body, newVersion })
    return c.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to publish template'
    console.error('Failed to publish template:', error)
    return c.json({ error: message }, 500)
  }
})

// POST /api/agents/:id/template-refresh - Refresh status
agents.post('/:id/template-refresh', async (c) => {
  try {
    const settings = getSettings()
    const skillsets = settings.skillsets || []
    await refreshAgentTemplates(skillsets)
    const slug = c.req.param('id')
    const status = await getAgentTemplateStatus(slug, skillsets)
    return c.json(status)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to refresh template'
    console.error('Failed to refresh template:', error)
    return c.json({ error: message }, 500)
  }
})

// POST /api/agents/:id/skills/refresh - Refresh skillset caches and reconcile skill status
agents.post('/:id/skills/refresh', async (c) => {
  try {
    const agentSlug = c.req.param('id')
    const settings = getSettings()
    const skillsets = settings.skillsets || []
    await refreshAgentSkills(agentSlug, skillsets)
    const skills = await getAgentSkillsWithStatus(agentSlug, skillsets)
    return c.json({ skills })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to refresh skills'
    console.error('Failed to refresh skills:', error)
    return c.json({ error: message }, 500)
  }
})

// GET /api/agents/:id/audit-log - Get combined proxy + MCP audit log for agent
agents.get('/:id/audit-log', async (c) => {
  try {
    const slug = c.req.param('id')

    const offset = parseInt(c.req.query('offset') ?? '0', 10)
    const limit = Math.min(parseInt(c.req.query('limit') ?? '20', 10), 100)

    // Fetch a window from each table (offset+limit from each, already sorted by time desc)
    // then merge, sort, and slice for the requested page
    const window = offset + limit
    const [proxyEntries, proxyTotal, mcpEntries, mcpTotal] = await Promise.all([
      db
        .select()
        .from(proxyAuditLog)
        .where(eq(proxyAuditLog.agentSlug, slug))
        .orderBy(desc(proxyAuditLog.createdAt))
        .limit(window),
      db
        .select({ count: count() })
        .from(proxyAuditLog)
        .where(eq(proxyAuditLog.agentSlug, slug)),
      db
        .select()
        .from(mcpAuditLog)
        .where(eq(mcpAuditLog.agentSlug, slug))
        .orderBy(desc(mcpAuditLog.createdAt))
        .limit(window),
      db
        .select({ count: count() })
        .from(mcpAuditLog)
        .where(eq(mcpAuditLog.agentSlug, slug)),
    ])

    // Normalize to a common shape
    const normalized = [
      ...proxyEntries.map((e) => ({
        id: e.id,
        source: 'proxy' as const,
        agentSlug: e.agentSlug,
        label: e.toolkit,
        targetUrl: `${e.targetHost}/${e.targetPath}`,
        method: e.method,
        statusCode: e.statusCode ?? null,
        errorMessage: e.errorMessage ?? null,
        durationMs: null as number | null,
        createdAt: e.createdAt,
      })),
      ...mcpEntries.map((e) => ({
        id: e.id,
        source: 'mcp' as const,
        agentSlug: e.agentSlug,
        label: e.remoteMcpName,
        targetUrl: e.requestPath,
        method: e.method,
        statusCode: e.statusCode ?? null,
        errorMessage: e.errorMessage ?? null,
        durationMs: e.durationMs ?? null,
        createdAt: e.createdAt,
      })),
    ]

    // Sort by time descending, then paginate
    normalized.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    const total = (proxyTotal[0]?.count ?? 0) + (mcpTotal[0]?.count ?? 0)
    const entries = normalized.slice(offset, offset + limit)

    return c.json({ entries, total })
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

    const filename = path.basename(filePath)
    const fileStream = fs.createReadStream(fullPath)
    const webStream = Readable.toWeb(fileStream) as ReadableStream

    const encodedFilename = encodeURIComponent(filename)
    c.header('Content-Disposition', `attachment; filename="${encodedFilename}"; filename*=UTF-8''${encodedFilename}`)
    c.header('Content-Type', 'application/octet-stream')
    c.header('Content-Length', stat.size.toString())

    return c.body(webStream)
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

// ============================================================
// Dashboard / Artifacts endpoints
// ============================================================

// GET /api/agents/:id/artifacts - List dashboards for an agent
agents.get('/:id/artifacts', async (c) => {
  try {
    const slug = c.req.param('id')


    // Try to get from running container first
    try {
      const client = containerManager.getClient(slug)
      // Use cached status to avoid spawning docker process
      const info = containerManager.getCachedInfo(slug)

      if (info.status === 'running') {
        const response = await client.fetch('/artifacts')
        if (response.ok) {
          return c.json(await response.json())
        }
      }
    } catch {
      // Container not running, fall through to filesystem
    }

    // Read from host filesystem when container is off
    const dashboards = await listArtifactsFromFilesystem(slug)
    return c.json(dashboards)
  } catch (error) {
    console.error('Failed to fetch artifacts:', error)
    return c.json({ error: 'Failed to fetch artifacts' }, 500)
  }
})

// Shared handler for proxying artifact requests to the container
const skipProxyRequestHeaders = new Set([
  'host', 'connection', 'transfer-encoding',
])

async function proxyArtifactRequest(c: any) {
  const agentSlug = c.req.param('id')
  const artifactSlug = c.req.param('artifactSlug')

  const client = containerManager.getClient(agentSlug)
  // Use cached status to avoid spawning docker process
  const info = containerManager.getCachedInfo(agentSlug)

  if (info.status !== 'running') {
    return c.json({ error: 'Agent is not running. Start the agent to view this dashboard.' }, 503)
  }

  // Build the container path
  const url = new URL(c.req.url)
  const prefix = `/api/agents/${agentSlug}/artifacts/${artifactSlug}`
  const subPath = url.pathname.slice(url.pathname.indexOf(prefix) + prefix.length) || '/'
  const containerPath = `/artifacts/${artifactSlug}${subPath}${url.search}`

  // Forward request headers (minus hop-by-hop headers)
  const reqHeaders = c.req.header() as Record<string, string>
  const headers: Record<string, string> = {}
  for (const key of Object.keys(reqHeaders)) {
    if (!skipProxyRequestHeaders.has(key.toLowerCase())) {
      headers[key] = reqHeaders[key]
    }
  }

  const init: RequestInit = { method: c.req.method, headers }
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    init.body = await c.req.arrayBuffer()
  }

  const response = await client.fetch(containerPath, init)

  return new Response(response.body, {
    status: response.status,
    headers: new Headers(response.headers),
  })
}

// ALL /api/agents/:id/artifacts/:slug/* - Proxy all methods to dashboard server
agents.all('/:id/artifacts/:artifactSlug/*', async (c) => {
  try {
    return await proxyArtifactRequest(c)
  } catch (error: any) {
    console.error('Failed to proxy artifact:', error)
    return c.json({ error: error.message || 'Failed to proxy artifact' }, 502)
  }
})

// Also handle without trailing path
agents.all('/:id/artifacts/:artifactSlug', async (c) => {
  try {
    return await proxyArtifactRequest(c)
  } catch (error: any) {
    console.error('Failed to proxy artifact:', error)
    return c.json({ error: error.message || 'Failed to proxy artifact' }, 502)
  }
})

// ============================================================
// Browser proxy endpoints
// ============================================================

// GET /api/agents/:id/browser/status - Check browser state
agents.get('/:id/browser/status', async (c) => {
  try {
    const slug = c.req.param('id')


    const client = containerManager.getClient(slug)
    // Use cached status to avoid spawning docker process
    const info = containerManager.getCachedInfo(slug)

    if (info.status !== 'running') {
      return c.json({ active: false, sessionId: null })
    }

    const response = await client.fetch('/browser/status')
    return c.json(await response.json())
  } catch (error) {
    console.error('Failed to get browser status:', error)
    return c.json({ active: false, sessionId: null })
  }
})

// POST /api/agents/:id/browser/:action - Proxy browser tool actions
agents.post('/:id/browser/:action', async (c) => {
  try {
    const slug = c.req.param('id')
    const action = c.req.param('action')


    const client = containerManager.getClient(slug)
    // Use cached status to avoid spawning docker process
    const info = containerManager.getCachedInfo(slug)

    if (info.status !== 'running') {
      return c.json({ error: 'Agent container is not running' }, 400)
    }

    const body = await c.req.json()
    const response = await client.fetch(`/browser/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    const data = await response.json()
    return c.json(data, response.status as any)
  } catch (error: any) {
    console.error('Failed to proxy browser action:', error)
    return c.json({ error: error.message || 'Failed to proxy browser action' }, 500)
  }
})

export default agents
