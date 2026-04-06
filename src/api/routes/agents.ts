import { Hono, type Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import type Anthropic from '@anthropic-ai/sdk'
import { randomUUID } from 'crypto'
import { Authenticated, AgentRead, AgentUser, AgentAdmin } from '../middleware/auth'
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
import { listWebhookTriggers, listActiveWebhookTriggers, listCancelledWebhookTriggers } from '@shared/lib/services/webhook-trigger-service'
import { trackServerEvent } from '@shared/lib/analytics/server-analytics'
import { messagePersister } from '@shared/lib/container/message-persister'
import {
  listSessions,
  getSessionSummary,
  updateSessionName,
  registerSession,
  getSessionMessagesWithCompact,
  getSession,
  getSessionMetadata,
  updateSessionMetadata,
  deleteSession,
  removeMessage,
  removeToolCall,
} from '@shared/lib/services/session-service'
import { getSessionJsonlPath, readFileOrNull, getAgentSessionsDir, readJsonlFile, getTempUploadsDir, ensureDirectory, removeDirectory } from '@shared/lib/utils/file-storage'
import { getMountsWithHealth, addMount, removeMount } from '@shared/lib/services/mount-service'
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
  listPendingScheduledTasksByAgents,
  listCancelledScheduledTasks,
} from '@shared/lib/services/scheduled-task-service'
import { db } from '@shared/lib/db'
import { connectedAccounts, agentConnectedAccounts, proxyAuditLog, remoteMcpServers, agentRemoteMcps, mcpAuditLog, agentAcl, user as userTable, messageAuthor, apiScopePolicies } from '@shared/lib/db/schema'
import { eq, and, inArray, desc, count, like, or } from 'drizzle-orm'
import { isAuthMode } from '@shared/lib/auth/mode'
import { getCurrentUserId } from '@shared/lib/auth/config'
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
import { listArtifactsFromFilesystem, deleteArtifactFromFilesystem, renameArtifactOnFilesystem } from '@shared/lib/services/artifact-service'
import { getSessionIdsWithUnreadNotifications, getUnreadNotificationsByAgents } from '@shared/lib/services/notification-service'
import { reviewManager } from '@shared/lib/proxy/review-manager'
import { getContainerHostUrl, getAppPort } from '@shared/lib/proxy/host-url'
import {
  exportAgentTemplate,
  exportAgentFull,
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
  collectAgentRequiredEnvVars,
} from '@shared/lib/services/agent-template-service'
import { withRetry } from '@shared/lib/utils/retry'
import { transformMessages, type TransformedMessage, type TransformedItem } from '@shared/lib/utils/message-transform'
import { getEffectiveModels, getEffectiveAgentLimits, getCustomEnvVars, getSettings } from '@shared/lib/config/settings'
import { getActiveLlmProvider } from '@shared/lib/llm-provider'
import { getPlatformAuthStatus } from '@shared/lib/services/platform-auth-service'
import { buildSkillsetScope, findVisibleSkillsetById } from '@shared/lib/utils/skillset-helpers'
import { revokeProxyToken } from '@shared/lib/proxy/token-store'
import { getAgentWorkspaceDir } from '@shared/lib/utils/file-storage'
import * as fs from 'fs'
import { Readable } from 'stream'
import pLimit from 'p-limit'
import * as path from 'path'
import type { ApiAgent } from '@shared/lib/types/api'

/**
 * Enrich an array of ApiAgent objects with summary fields:
 * active/awaiting sessions, last activity, scheduled tasks, dashboards.
 * Batch DB queries upfront, then parallelize per-agent FS operations.
 */
async function enrichAgentsWithSummary(agents: ApiAgent[]): Promise<ApiAgent[]> {
  const slugs = agents.map(a => a.slug)

  // Batch DB queries: 2 queries instead of 2*N individual queries
  const [unreadByAgent, tasksByAgent] = await Promise.all([
    getUnreadNotificationsByAgents(slugs),
    listPendingScheduledTasksByAgents(slugs),
  ])

  const limit = pLimit(5)
  return Promise.all(
    agents.map((agent) => limit(async () => {
      // Only FS operations remain per-agent (parallelized)
      const [sessionSummary, artifacts] = await Promise.all([
        getSessionSummary(agent.slug),
        listArtifactsFromFilesystem(agent.slug),
      ])

      const unreadSessionIds = unreadByAgent.get(agent.slug) ?? new Set<string>()
      const pendingTasks = tasksByAgent.get(agent.slug) ?? []

      // Compute session flags from in-memory state (no I/O needed)
      let hasActiveSessions = false
      let hasSessionsAwaitingInput = false
      let hasUnreadNotifications = false
      const hasAgentLevelReviews = reviewManager.getPendingReviewsForAgent(agent.slug).length > 0
      for (const sessionId of sessionSummary.sessionIds) {
        const isActive = messagePersister.isSessionActive(sessionId)
        if (isActive) {
          hasActiveSessions = true
        }
        if (messagePersister.isSessionAwaitingInput(sessionId) || (isActive && hasAgentLevelReviews)) {
          hasSessionsAwaitingInput = true
        }
        if (unreadSessionIds.has(sessionId)) {
          hasUnreadNotifications = true
        }
      }

      // Compute scheduled task summary
      const scheduledTaskCount = pendingTasks.length
      let nextScheduledTaskAt: Date | null = null
      for (const task of pendingTasks) {
        if (task.nextExecutionAt) {
          const ts = new Date(task.nextExecutionAt)
          if (!nextScheduledTaskAt || ts < nextScheduledTaskAt) {
            nextScheduledTaskAt = ts
          }
        }
      }

      return {
        ...agent,
        hasActiveSessions,
        hasSessionsAwaitingInput,
        hasUnreadNotifications,
        sessionCount: sessionSummary.sessionCount,
        lastActivityAt: sessionSummary.lastActivityAt,
        scheduledTaskCount,
        nextScheduledTaskAt,
        dashboardCount: artifacts.length,
        dashboardNames: artifacts.map((a) => a.name || a.slug),
        dashboardSlugs: artifacts.map((a) => a.slug),
      }
    }))
  )
}

/**
 * For interrupted Task tool calls (no result), discover the subagent ID
 * by scanning the subagents directory so the UI can still show subagent messages.
 */
export async function resolveInterruptedSubagents(
  items: TransformedItem[],
  agentSlug: string,
  sessionId: string
): Promise<void> {
  // Collect Task tool calls, separating resolved from unresolved
  const resolvedAgentIds = new Set<string>()
  const unresolvedTaskCalls: TransformedMessage['toolCalls'][number][] = []

  for (const item of items) {
    if (item.type !== 'assistant') continue
    const msg = item as TransformedMessage
    for (const tc of msg.toolCalls) {
      if (tc.name !== 'Task' && tc.name !== 'Agent') continue
      if (tc.subagent?.agentId) {
        resolvedAgentIds.add(tc.subagent.agentId)
      } else {
        unresolvedTaskCalls.push(tc)
      }
    }
  }

  if (unresolvedTaskCalls.length === 0) return

  // Scan the subagents directory for available files
  const sessionsDir = getAgentSessionsDir(agentSlug)
  const subagentsDir = path.join(sessionsDir, sessionId, 'subagents')
  let files: string[]
  try {
    files = await fs.promises.readdir(subagentsDir)
  } catch {
    return // No subagents directory
  }

  // Get unmatched subagent files sorted by mtime (creation order)
  const unmatchedFiles: { id: string; mtime: number }[] = []
  for (const file of files) {
    if (!file.startsWith('agent-') || !file.endsWith('.jsonl')) continue
    const id = file.replace('agent-', '').replace('.jsonl', '')
    if (resolvedAgentIds.has(id)) continue
    try {
      const stat = await fs.promises.stat(path.join(subagentsDir, file))
      unmatchedFiles.push({ id, mtime: stat.mtimeMs })
    } catch {
      // skip unreadable files
    }
  }

  unmatchedFiles.sort((a, b) => a.mtime - b.mtime)

  // Match unresolved Task calls to unmatched subagent files in order
  for (let i = 0; i < unresolvedTaskCalls.length && i < unmatchedFiles.length; i++) {
    unresolvedTaskCalls[i].subagent = {
      agentId: unmatchedFiles[i].id,
      status: 'cancelled',
    }
  }
}

const agents = new Hono()

function getAllSkillsets() {
  return getSettings().skillsets || []
}

function getSkillsetScope() {
  return buildSkillsetScope(getAllSkillsets(), getPlatformAuthStatus().orgId)
}

agents.use('*', Authenticated())

// ============================================================
// Routes that must be registered BEFORE /:id middleware
// (paths like /import-template would otherwise match as :id)
// ============================================================

// POST /api/agents/import-template - Import agent from uploaded ZIP
// Supports both single-request (file field) and chunked upload (chunk field)
agents.post('/import-template', async (c) => {
  try {
    const formData = await c.req.formData()

    // Check if this is a chunked upload
    const chunk = formData.get('chunk') as File | null
    if (chunk) {
      return await handleChunkedImport(c, formData, chunk)
    }

    // Legacy single-request upload
    const file = formData.get('file') as File | null
    if (!file) {
      return c.json({ error: 'No file or chunk provided' }, 400)
    }

    const arrayBuffer = await file.arrayBuffer()
    const zipBuffer = Buffer.from(arrayBuffer)

    return await processImport(c, zipBuffer, formData)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to import template'
    console.error('Failed to import template:', error)
    return c.json({ error: message }, 500)
  }
})

async function handleChunkedImport(c: Context, formData: FormData, chunk: File) {
  const uploadId = formData.get('uploadId') as string | null
  const chunkIndexStr = formData.get('chunkIndex') as string | null
  const totalChunksStr = formData.get('totalChunks') as string | null

  if (!uploadId || chunkIndexStr === null || totalChunksStr === null) {
    return c.json({ error: 'Missing chunked upload fields: uploadId, chunkIndex, totalChunks' }, 400)
  }

  // Validate uploadId format (UUID only — prevent path traversal)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uploadId)) {
    return c.json({ error: 'Invalid uploadId format' }, 400)
  }

  const chunkIndex = parseInt(chunkIndexStr, 10)
  const totalChunks = parseInt(totalChunksStr, 10)

  if (isNaN(chunkIndex) || isNaN(totalChunks) || chunkIndex < 0 || totalChunks < 1 || chunkIndex >= totalChunks || totalChunks > 200) {
    return c.json({ error: 'Invalid chunkIndex or totalChunks' }, 400)
  }

  const uploadDir = path.join(getTempUploadsDir(), uploadId)
  await ensureDirectory(uploadDir)

  // Write this chunk to disk
  const chunkBuffer = Buffer.from(await chunk.arrayBuffer())
  await fs.promises.writeFile(path.join(uploadDir, `chunk-${chunkIndex}`), chunkBuffer)

  // Check if all chunks are present
  const files = await fs.promises.readdir(uploadDir)
  const chunkFiles = files.filter((f) => f.startsWith('chunk-'))

  if (chunkFiles.length < totalChunks) {
    return c.json({ status: 'chunk_received', chunkIndex })
  }

  // Prevent duplicate assembly from concurrent requests
  const lockPath = path.join(uploadDir, '.assembling')
  try {
    await fs.promises.writeFile(lockPath, '', { flag: 'wx' }) // fails if already exists
  } catch {
    return c.json({ status: 'chunk_received', chunkIndex })
  }

  // All chunks received — assemble and process
  try {
    const buffers: Buffer[] = []
    for (let i = 0; i < totalChunks; i++) {
      buffers.push(await fs.promises.readFile(path.join(uploadDir, `chunk-${i}`)))
    }
    const zipBuffer = Buffer.concat(buffers)

    return await processImport(c, zipBuffer, formData)
  } finally {
    // Clean up temp chunks
    try { await removeDirectory(uploadDir) } catch { /* ignore cleanup errors */ }
  }
}

async function processImport(c: Context, zipBuffer: Buffer, formData: FormData) {
  const nameOverride = formData.get('name') as string | null
  const mode = formData.get('mode') as string | null
  const importMode = mode === 'full' ? 'full' : 'template'

  const agent = await importAgentFromTemplate(zipBuffer, nameOverride || undefined, importMode)
  await createOwnerAcl(c, agent.slug)
  const hasOnboarding = await hasOnboardingSkill(agent.slug)
  const requiredEnvVars = await collectAgentRequiredEnvVars(agent.slug, {
    excludeExistingSecrets: importMode === 'full',
  })
  return c.json({ ...agent, hasOnboarding, requiredEnvVars }, 201)
}

// GET /api/agents/discoverable-agents - List agents available from skillsets
// Uses ?refresh=true to force a cache refresh before reading
agents.get('/discoverable-agents', async (c) => {
  try {
    const scope = getSkillsetScope()
    const ssArray = scope.visibleSkillsets
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

    const scope = getSkillsetScope()
    const config = findVisibleSkillsetById(scope, skillsetId)
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

    await createOwnerAcl(c, agent.slug)
    const hasOnboarding = await hasOnboardingSkill(agent.slug)
    const requiredEnvVars = await collectAgentRequiredEnvVars(agent.slug)
    return c.json({ ...agent, hasOnboarding, requiredEnvVars }, 201)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to install agent from skillset'
    console.error('Failed to install agent from skillset:', error)
    return c.json({ error: message }, 500)
  }
})

// GET /api/agents/my-roles - Get current user's roles on all agents (with member counts)
agents.get('/my-roles', async (c) => {
  try {
    if (!isAuthMode()) {
      return c.json({ roles: {} })
    }
    const userId = getCurrentUserId(c)

    // Get user's roles
    const rows = await db
      .select({ agentSlug: agentAcl.agentSlug, role: agentAcl.role })
      .from(agentAcl)
      .where(eq(agentAcl.userId, userId))

    if (rows.length === 0) {
      return c.json({ roles: {} })
    }

    // Get member counts for those agents in one query
    const slugs = rows.map((r) => r.agentSlug)
    const counts = await db
      .select({ agentSlug: agentAcl.agentSlug, memberCount: count() })
      .from(agentAcl)
      .where(inArray(agentAcl.agentSlug, slugs))
      .groupBy(agentAcl.agentSlug)

    const countMap = new Map(counts.map((c) => [c.agentSlug, c.memberCount]))

    const roles: Record<string, { role: string; memberCount: number }> = {}
    for (const row of rows) {
      roles[row.agentSlug] = {
        role: row.role,
        memberCount: countMap.get(row.agentSlug) ?? 1,
      }
    }
    return c.json({ roles })
  } catch (error) {
    console.error('Failed to fetch agent roles:', error)
    return c.json({ error: 'Failed to fetch agent roles' }, 500)
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

// Create owner ACL entry when an agent is created in auth mode
async function createOwnerAcl(c: Context, agentSlug: string) {
  if (!isAuthMode()) return
  const userId = getCurrentUserId(c)
  await db.insert(agentAcl).values({
    id: randomUUID(),
    userId,
    agentSlug,
    role: 'owner',
    createdAt: new Date(),
  })
}

// Create LLM client using the active provider
function getLlmClient(): Anthropic {
  return getActiveLlmProvider().createClient()
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
    const anthropic = getLlmClient()
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

// GET /api/agents - List agents with status (filtered by ACL in auth mode)
// Response includes pre-aggregated summary: active sessions, scheduled tasks, dashboards.
agents.get('/', async (c) => {
  try {
    // In auth mode, only return agents the user has explicit ACL entries for.
    // Note: Admins do NOT get implicit access to all agents in the listing.
    // This is intentional — admin privileges grant bypass access to individual
    // agent routes (via middleware), but agents must be explicitly shared with
    // admins for them to appear in the sidebar. This prevents admins from
    // seeing every agent in large deployments.
    let agentList: ApiAgent[]
    if (isAuthMode()) {
      const userId = getCurrentUserId(c)
      const rows = await db
        .select({ agentSlug: agentAcl.agentSlug })
        .from(agentAcl)
        .where(eq(agentAcl.userId, userId))
      const agentLimit = pLimit(10)
      const agents = await Promise.all(
        rows.map((r) => agentLimit(() => getAgentWithStatus(r.agentSlug)))
      )
      agentList = agents.filter((a): a is ApiAgent => a !== null)
    } else {
      agentList = await listAgentsWithStatus()
    }

    return c.json(await enrichAgentsWithSummary(agentList))
  } catch (error) {
    console.error('Failed to fetch agents:', error)
    return c.json({ error: 'Failed to fetch agents' }, 500)
  }
})

// POST /api/agents - Create a new agent (with owner ACL in auth mode)
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

    await createOwnerAcl(c, agent.slug)

    return c.json(agent, 201)
  } catch (error) {
    console.error('Failed to create agent:', error)
    return c.json({ error: 'Failed to create agent' }, 500)
  }
})

// GET /api/agents/:id - Get a single agent
agents.get('/:id', AgentRead(), async (c) => {
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
agents.put('/:id', AgentAdmin(), async (c) => {
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
agents.delete('/:id', AgentAdmin(), async (c) => {
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

    // Clean up ACL entries and message author records
    await db.delete(agentAcl).where(eq(agentAcl.agentSlug, slug))
    if (isAuthMode()) {
      await db.delete(messageAuthor).where(eq(messageAuthor.agentSlug, slug))
    }

    return c.body(null, 204)
  } catch (error) {
    console.error('Failed to delete agent:', error)
    return c.json({ error: 'Failed to delete agent' }, 500)
  }
})

// ============================================================
// Agent Access (ACL) endpoints
// ============================================================

// GET /api/agents/:id/access - List users with roles on this agent
agents.get('/:id/access', AgentAdmin(), async (c) => {
  try {
    const slug = c.req.param('id')
    const rows = await db
      .select({
        userId: agentAcl.userId,
        role: agentAcl.role,
        createdAt: agentAcl.createdAt,
        userName: userTable.name,
        userEmail: userTable.email,
      })
      .from(agentAcl)
      .innerJoin(userTable, eq(agentAcl.userId, userTable.id))
      .where(eq(agentAcl.agentSlug, slug))
    return c.json(rows)
  } catch (error) {
    console.error('Failed to fetch agent access:', error)
    return c.json({ error: 'Failed to fetch agent access' }, 500)
  }
})

// POST /api/agents/:id/access - Invite user (assign role)
agents.post('/:id/access', AgentAdmin(), async (c) => {
  try {
    const slug = c.req.param('id')
    const { userId, role } = await c.req.json()

    if (!userId || !role) {
      return c.json({ error: 'userId and role are required' }, 400)
    }
    if (!['owner', 'user', 'viewer'].includes(role)) {
      return c.json({ error: 'Invalid role. Must be owner, user, or viewer' }, 400)
    }

    // Check user exists
    const [targetUser] = await db
      .select({ id: userTable.id })
      .from(userTable)
      .where(eq(userTable.id, userId))
      .limit(1)
    if (!targetUser) {
      return c.json({ error: 'User not found' }, 404)
    }

    // Check if ACL already exists
    const [existing] = await db
      .select({ id: agentAcl.id })
      .from(agentAcl)
      .where(and(eq(agentAcl.userId, userId), eq(agentAcl.agentSlug, slug)))
      .limit(1)
    if (existing) {
      return c.json({ error: 'User already has access to this agent' }, 409)
    }

    await db.insert(agentAcl).values({
      id: randomUUID(),
      userId,
      agentSlug: slug,
      role,
      createdAt: new Date(),
    })

    return c.json({ ok: true }, 201)
  } catch (error) {
    console.error('Failed to add agent access:', error)
    return c.json({ error: 'Failed to add agent access' }, 500)
  }
})

// PATCH /api/agents/:id/access/:userId - Change user's role
agents.patch('/:id/access/:userId', AgentAdmin(), async (c) => {
  try {
    const slug = c.req.param('id')
    const targetUserId = c.req.param('userId')
    const { role } = await c.req.json()

    if (!role || !['owner', 'user', 'viewer'].includes(role)) {
      return c.json({ error: 'Invalid role. Must be owner, user, or viewer' }, 400)
    }

    // Transaction to prevent TOCTOU race on last-owner check
    // Note: better-sqlite3 transactions are synchronous — no async/await inside
    const error = db.transaction((tx) => {
      const [currentAcl] = tx
        .select({ role: agentAcl.role })
        .from(agentAcl)
        .where(and(eq(agentAcl.userId, targetUserId), eq(agentAcl.agentSlug, slug)))
        .limit(1)
        .all()

      if (!currentAcl) return 'User does not have access to this agent'

      if (currentAcl.role === 'owner' && role !== 'owner') {
        const [{ ownerCount }] = tx
          .select({ ownerCount: count() })
          .from(agentAcl)
          .where(and(eq(agentAcl.agentSlug, slug), eq(agentAcl.role, 'owner')))
          .all()
        if (ownerCount <= 1) return 'Cannot change role: agent must have at least one owner'
      }

      tx
        .update(agentAcl)
        .set({ role })
        .where(and(eq(agentAcl.userId, targetUserId), eq(agentAcl.agentSlug, slug)))
        .run()

      return null
    })

    if (error) {
      const status = error.includes('does not have access') ? 404 : 400
      return c.json({ error }, status)
    }
    return c.json({ ok: true })
  } catch (error) {
    console.error('Failed to update agent access:', error)
    return c.json({ error: 'Failed to update agent access' }, 500)
  }
})

// DELETE /api/agents/:id/access/:userId - Remove user's access
agents.delete('/:id/access/:userId', AgentAdmin(), async (c) => {
  try {
    const slug = c.req.param('id')
    const targetUserId = c.req.param('userId')

    // Transaction to prevent TOCTOU race on last-owner check
    // Note: better-sqlite3 transactions are synchronous — no async/await inside
    const error = db.transaction((tx) => {
      const [currentAcl] = tx
        .select({ role: agentAcl.role })
        .from(agentAcl)
        .where(and(eq(agentAcl.userId, targetUserId), eq(agentAcl.agentSlug, slug)))
        .limit(1)
        .all()

      if (!currentAcl) return 'User does not have access to this agent'

      if (currentAcl.role === 'owner') {
        const [{ ownerCount }] = tx
          .select({ ownerCount: count() })
          .from(agentAcl)
          .where(and(eq(agentAcl.agentSlug, slug), eq(agentAcl.role, 'owner')))
          .all()
        if (ownerCount <= 1) return 'Cannot remove access: agent must have at least one owner'
      }

      tx
        .delete(agentAcl)
        .where(and(eq(agentAcl.userId, targetUserId), eq(agentAcl.agentSlug, slug)))
        .run()

      return null
    })

    if (error) {
      const status = error.includes('does not have access') ? 404 : 400
      return c.json({ error }, status)
    }
    return c.body(null, 204)
  } catch (error) {
    console.error('Failed to remove agent access:', error)
    return c.json({ error: 'Failed to remove agent access' }, 500)
  }
})

// POST /api/agents/:id/leave - Remove yourself from an agent's ACL
agents.post('/:id/leave', AgentRead(), async (c) => {
  try {
    const slug = c.req.param('id')
    const userId = getCurrentUserId(c)

    const error = db.transaction((tx) => {
      const [currentAcl] = tx
        .select({ role: agentAcl.role })
        .from(agentAcl)
        .where(and(eq(agentAcl.userId, userId), eq(agentAcl.agentSlug, slug)))
        .limit(1)
        .all()

      if (!currentAcl) return 'You do not have access to this agent'

      if (currentAcl.role === 'owner') {
        const [{ ownerCount }] = tx
          .select({ ownerCount: count() })
          .from(agentAcl)
          .where(and(eq(agentAcl.agentSlug, slug), eq(agentAcl.role, 'owner')))
          .all()
        if (ownerCount <= 1) return 'Cannot leave: you are the only owner'
      }

      tx
        .delete(agentAcl)
        .where(and(eq(agentAcl.userId, userId), eq(agentAcl.agentSlug, slug)))
        .run()

      return null
    })

    if (error) {
      return c.json({ error }, 400)
    }
    return c.body(null, 204)
  } catch (error) {
    console.error('Failed to leave agent:', error)
    return c.json({ error: 'Failed to leave agent' }, 500)
  }
})

// GET /api/agents/:id/access/search-users - Search users for invite
agents.get('/:id/access/search-users', AgentAdmin(), async (c) => {
  try {
    const query = c.req.query('q')?.trim()
    if (!query || query.length < 2) {
      return c.json([])
    }

    const slug = c.req.param('id')

    // Get users who already have access
    const existingUserIds = await db
      .select({ userId: agentAcl.userId })
      .from(agentAcl)
      .where(eq(agentAcl.agentSlug, slug))

    const excludeIds = new Set(existingUserIds.map((r) => r.userId))

    // Search users by name or email (SQLite LIKE is case-insensitive by default)
    // Escape LIKE wildcards to prevent pattern injection (e.g. searching "%" matching all users)
    const escaped = query.replace(/%/g, '\\%').replace(/_/g, '\\_')
    const users = await db
      .select({ id: userTable.id, name: userTable.name, email: userTable.email })
      .from(userTable)
      .where(or(like(userTable.name, `%${escaped}%`), like(userTable.email, `%${escaped}%`)))
      .limit(20)

    return c.json(users.filter((u) => !excludeIds.has(u.id)))
  } catch (error) {
    console.error('Failed to search users:', error)
    return c.json({ error: 'Failed to search users' }, 500)
  }
})

// POST /api/agents/:id/start - Start an agent's container
agents.post('/:id/start', AgentUser(), async (c) => {
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
agents.post('/:id/stop', AgentUser(), async (c) => {
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

// POST /api/agents/:id/open-directory - Get workspace path, optionally open in system file manager
agents.post('/:id/open-directory', AgentAdmin(), async (c) => {
  try {
    const slug = c.req.param('id')
    const workspaceDir = getAgentWorkspaceDir(slug)

    // Ensure directory exists
    await fs.promises.mkdir(workspaceDir, { recursive: true })

    const body = await c.req.json().catch(() => ({}))
    if (body.open) {
      const { exec } = await import('child_process')
      const platform = process.platform
      const command =
        platform === 'darwin' ? 'open' :
        platform === 'win32' ? 'explorer' :
        'xdg-open'

      exec(`${command} "${workspaceDir}"`)
    }

    return c.json({ success: true, path: workspaceDir })
  } catch (error) {
    console.error('Failed to open agent directory:', error)
    return c.json({ error: 'Failed to open agent directory' }, 500)
  }
})

// GET /api/agents/:id/sessions - List sessions for an agent
agents.get('/:id/sessions', AgentRead(), async (c) => {
  try {
    const slug = c.req.param('id')


    const sessionList = await listSessions(slug, { excludeAutomated: true })
    const unreadSessionIds = await getSessionIdsWithUnreadNotifications(slug)
    const hasAgentLevelReviews = reviewManager.getPendingReviewsForAgent(slug).length > 0
    const sessionsWithStatus = sessionList.map((session) => {
      const isActive = messagePersister.isSessionActive(session.id)
      return {
        ...session,
        isActive,
        isAwaitingInput: messagePersister.isSessionAwaitingInput(session.id) || (isActive && hasAgentLevelReviews),
        hasUnreadNotifications: unreadSessionIds.has(session.id),
      }
    })

    return c.json(sessionsWithStatus)
  } catch (error) {
    console.error('Failed to fetch sessions:', error)
    return c.json({ error: 'Failed to fetch sessions' }, 500)
  }
})

// POST /api/agents/:id/sessions - Create a new session with initial message
agents.post('/:id/sessions', AgentUser(), async (c) => {
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

    // In auth mode, generate a UUID for the initial message author attribution
    let initialMessageUuid: string | undefined
    if (isAuthMode()) {
      initialMessageUuid = randomUUID()
    }

    const containerSession = await client.createSession({
      availableEnvVars: availableEnvVars.length > 0 ? availableEnvVars : undefined,
      initialMessage: message.trim(),
      initialMessageUuid,
      model: getEffectiveModels().agentModel,
      browserModel: getEffectiveModels().browserModel,
      maxOutputTokens: agentLimits.maxOutputTokens,
      maxThinkingTokens: agentLimits.maxThinkingTokens,
      maxTurns: agentLimits.maxTurns,
      maxBudgetUsd: agentLimits.maxBudgetUsd,
      customEnvVars: Object.keys(customEnvVars).length > 0 ? customEnvVars : undefined,
      maxBrowserTabs: getSettings().app?.maxBrowserTabs,
    })
    const sessionId = containerSession.id

    // Record author for initial message after we know the sessionId
    if (isAuthMode() && initialMessageUuid) {
      const userId = getCurrentUserId(c)
      await db.insert(messageAuthor).values({
        id: initialMessageUuid,
        sessionId,
        agentSlug: slug,
        userId,
      })
    }

    await registerSession(slug, sessionId, 'New Session')
    await messagePersister.subscribeToSession(sessionId, client, sessionId, slug)
    // Store slash commands from container's init event (captured during session creation)
    if (containerSession.slashCommands && containerSession.slashCommands.length > 0) {
      messagePersister.setSlashCommands(sessionId, containerSession.slashCommands)
      updateSessionMetadata(slug, sessionId, { slashCommands: containerSession.slashCommands }).catch(console.error)
    }
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
agents.get('/:id/sessions/:sessionId/messages', AgentRead(), async (c) => {
  try {
    const agentSlug = c.req.param('id')
    const sessionId = c.req.param('sessionId')


    const messages = await getSessionMessagesWithCompact(agentSlug, sessionId)
    const filtered = messages.filter((m) => !('isMeta' in m && m.isMeta))
    const transformed = transformMessages(filtered)

    // Discover subagent IDs for interrupted Task tool calls that have no result
    await resolveInterruptedSubagents(transformed, agentSlug, sessionId)

    // In auth mode, annotate user messages with sender info
    if (isAuthMode()) {
      const userMessageIds = transformed
        .filter((m) => m.type === 'user')
        .map((m) => m.id)

      if (userMessageIds.length > 0) {
        const authors = await db
          .select({
            messageId: messageAuthor.id,
            userId: messageAuthor.userId,
            userName: userTable.name,
            userEmail: userTable.email,
          })
          .from(messageAuthor)
          .innerJoin(userTable, eq(messageAuthor.userId, userTable.id))
          .where(eq(messageAuthor.sessionId, sessionId))

        const authorMap = new Map(authors.map((a) => [a.messageId, a]))

        for (const msg of transformed) {
          if (msg.type !== 'user') continue
          const author = authorMap.get(msg.id)
          if (author) {
            msg.sender = {
              id: author.userId,
              name: author.userName,
              email: author.userEmail,
            }
          }
        }
      }
    }

    return c.json(transformed)
  } catch (error) {
    console.error('Failed to fetch messages:', error)
    return c.json({ error: 'Failed to fetch messages' }, 500)
  }
})

// DELETE /api/agents/:id/sessions/:sessionId/messages/:messageId - Remove a message from history
agents.delete('/:id/sessions/:sessionId/messages/:messageId', AgentUser(), async (c) => {
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
agents.delete('/:id/sessions/:sessionId/tool-calls/:toolCallId', AgentUser(), async (c) => {
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
agents.get('/:id/sessions/:sessionId/subagent/:agentId/messages', AgentRead(), async (c) => {
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
agents.get('/:id/sessions/:sessionId/raw-log', AgentRead(), async (c) => {
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
agents.post('/:id/sessions/:sessionId/messages', AgentUser(), async (c) => {
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

    // In auth mode, generate a UUID and record the sender for message attribution
    let messageUuid: string | undefined
    if (isAuthMode()) {
      const userId = getCurrentUserId(c)
      messageUuid = randomUUID()
      await db.insert(messageAuthor).values({
        id: messageUuid,
        sessionId,
        agentSlug,
        userId,
      })
    }

    // Broadcast user message to other SSE viewers (auth mode shared agents)
    if (isAuthMode()) {
      const user = c.get('user' as never) as { id: string; name: string }
      messagePersister.broadcastSessionEvent(sessionId, {
        type: 'user_message',
        content: content.trim(),
        sender: { id: user.id, name: user.name },
      })
    }

    await client.sendMessage(sessionId, content.trim(), messageUuid)

    return c.json({ success: true }, 201)
  } catch (error) {
    console.error('Failed to send message:', error)
    return c.json({ error: 'Failed to send message' }, 500)
  }
})

// POST /api/agents/:id/sessions/:sessionId/typing - Broadcast typing indicator (auth mode only)
agents.post('/:id/sessions/:sessionId/typing', AgentUser(), async (c) => {
  if (!isAuthMode()) return c.json({ ok: true })

  const sessionId = c.req.param('sessionId')
  const user = c.get('user' as never) as { id: string; name: string }

  messagePersister.broadcastSessionEvent(sessionId, {
    type: 'user_typing',
    sender: { id: user.id, name: user.name },
  })

  return c.json({ ok: true })
})

// GET /api/agents/:id/sessions/:sessionId - Get a single session
agents.get('/:id/sessions/:sessionId', AgentRead(), async (c) => {
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
      scheduledTaskId: metadata?.scheduledTaskId,
      scheduledTaskName: metadata?.scheduledTaskName,
      webhookTriggerId: metadata?.webhookTriggerId,
      webhookTriggerName: metadata?.webhookTriggerName,
    })
  } catch (error) {
    console.error('Failed to fetch session:', error)
    return c.json({ error: 'Failed to fetch session' }, 500)
  }
})

// PATCH /api/agents/:id/sessions/:sessionId - Update a session (e.g., rename)
agents.patch('/:id/sessions/:sessionId', AgentUser(), async (c) => {
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
agents.delete('/:id/sessions/:sessionId', AgentAdmin(), async (c) => {
  try {
    const agentSlug = c.req.param('id')
    const sessionId = c.req.param('sessionId')


    const session = await getSession(agentSlug, sessionId)

    if (!session) {
      return c.json({ error: 'Session not found' }, 404)
    }

    messagePersister.unsubscribeFromSession(sessionId)
    await deleteSession(agentSlug, sessionId)

    // Clean up message author records for this session
    if (isAuthMode()) {
      await db.delete(messageAuthor).where(eq(messageAuthor.sessionId, sessionId))
    }

    return c.body(null, 204)
  } catch (error) {
    console.error('Failed to delete session:', error)
    return c.json({ error: 'Failed to delete session' }, 500)
  }
})

// GET /api/agents/:id/sessions/:sessionId/stream - SSE stream for real-time message updates
agents.get('/:id/sessions/:sessionId/stream', AgentRead(), async (c) => {
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

      // Send initial connection message (include slash commands for late-joining clients)
      const agentSlug = c.req.param('id')
      const isActive = messagePersister.isSessionActive(sessionId)
      let slashCommands = messagePersister.getSlashCommands(sessionId)
      // Fall back to persisted metadata (e.g. after container restart)
      if (slashCommands.length === 0) {
        const meta = await getSessionMetadata(agentSlug, sessionId)
        if (meta?.slashCommands && meta.slashCommands.length > 0) {
          slashCommands = meta.slashCommands
          messagePersister.setSlashCommands(sessionId, slashCommands)
        }
      }
      await stream.writeSSE({
        data: JSON.stringify({
          type: 'connected',
          isActive,
          slashCommands: slashCommands.length > 0 ? slashCommands : undefined,
        }),
        event: 'message',
      })

      // Replay any pending computer use requests (survives SSE reconnection)
      const pendingCU = messagePersister.getPendingComputerUseRequests(sessionId)
      for (const req of pendingCU) {
        await stream.writeSSE({
          data: JSON.stringify({ type: 'computer_use_request', ...req }),
          event: 'message',
        })
      }

      // Replay current computer use grab state (with icon if cached)
      const agentSlugForStream = c.req.param('id')
      const { computerUsePermissionManager: cuPermMgr } = await import('@shared/lib/computer-use/permission-manager')
      const grabbedApp = cuPermMgr.getGrabbedApp(agentSlugForStream)
      if (grabbedApp) {
        const { getAppIconBase64 } = await import('@shared/lib/computer-use/app-icon')
        const appIcon = await getAppIconBase64(grabbedApp)
        await stream.writeSSE({
          data: JSON.stringify({ type: 'computer_use_grab_changed', app: grabbedApp, ...(appIcon && { appIcon }) }),
          event: 'message',
        })
      }

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
agents.post('/:id/sessions/:sessionId/interrupt', AgentUser(), async (c) => {
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
agents.post('/:id/sessions/:sessionId/provide-secret', AgentUser(), async (c) => {
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

      trackServerEvent('request_declined', { type: 'secret', withReason: !!declineReason })
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
agents.post('/:id/sessions/:sessionId/provide-connected-account', AgentUser(), async (c) => {
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

      trackServerEvent('request_declined', { type: 'connected_account', withReason: !!declineReason })
      return c.json({ success: true, declined: true })
    }

    if (!accountIds || accountIds.length === 0) {
      return c.json(
        { error: 'accountIds is required when not declining' },
        400
      )
    }

    // Get the selected accounts (scoped to user in auth mode)
    const userId = getCurrentUserId(c)
    const accounts = await db
      .select()
      .from(connectedAccounts)
      .where(and(
        inArray(connectedAccounts.id, accountIds),
        isAuthMode() ? eq(connectedAccounts.userId, userId) : undefined
      ))

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
agents.post('/:id/sessions/:sessionId/answer-question', AgentUser(), async (c) => {
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

      trackServerEvent('request_declined', { type: 'question', withReason: !!declineReason })
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

// POST /api/agents/:id/sessions/:sessionId/complete-browser-input - Complete or cancel a browser input request
agents.post('/:id/sessions/:sessionId/complete-browser-input', AgentUser(), async (c) => {
  try {
    const agentSlug = c.req.param('id')
    const body = await c.req.json()
    const { toolUseId, decline, declineReason } = body

    if (!toolUseId) {
      return c.json({ error: 'toolUseId is required' }, 400)
    }

    const client = containerManager.getClient(agentSlug)

    if (decline) {
      const reason = declineReason || 'User wants to chat with the agent'

      const rejectResponse = await client.fetch(
        `/inputs/${encodeURIComponent(toolUseId)}/reject`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason }),
        }
      )

      if (!rejectResponse.ok) {
        let errorDetails = 'Unknown error'
        try {
          const error = await rejectResponse.json()
          errorDetails = JSON.stringify(error)
        } catch {
          errorDetails = await rejectResponse.text()
        }
        console.error(`[complete-browser-input] Failed to reject: ${errorDetails}`)
        return c.json({ error: 'Failed to reject browser input request' }, 500)
      }

      // Interrupt the session so the user can chat directly with the agent
      const sessionId = c.req.param('sessionId')
      try {
        await client.interruptSession(sessionId)
      } catch (e) {
        console.error(`[complete-browser-input] Failed to interrupt session: ${e}`)
      }
      await messagePersister.markSessionInterrupted(sessionId)

      trackServerEvent('request_declined', { type: 'browser_input', withReason: !!declineReason })
      return c.json({ success: true, declined: true })
    }

    // User completed the browser interaction
    const resolveResponse = await client.fetch(
      `/inputs/${encodeURIComponent(toolUseId)}/resolve`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: 'completed' }),
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
      console.error(`[complete-browser-input] Failed to resolve: ${errorDetails}`)
      return c.json({ error: 'Failed to complete browser input request' }, 500)
    }

    return c.json({ success: true })
  } catch (error) {
    console.error('Failed to complete browser input:', error)
    return c.json({ error: 'Failed to complete browser input' }, 500)
  }
})

// POST /api/agents/:id/sessions/:sessionId/run-script - Run or deny a script execution request
agents.post('/:id/sessions/:sessionId/run-script', AgentUser(), async (c) => {
  try {
    const agentSlug = c.req.param('id')
    const body = await c.req.json()
    const { toolUseId, script, scriptType, decline, declineReason } = body

    if (!toolUseId) {
      return c.json({ error: 'toolUseId is required' }, 400)
    }

    const client = containerManager.getClient(agentSlug)

    if (decline) {
      const reason = declineReason || 'User denied script execution'

      const rejectResponse = await client.fetch(
        `/inputs/${encodeURIComponent(toolUseId)}/reject`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason }),
        }
      )

      if (!rejectResponse.ok) {
        let errorDetails = 'Unknown error'
        try {
          const error = await rejectResponse.json()
          errorDetails = JSON.stringify(error)
        } catch {
          errorDetails = await rejectResponse.text()
        }
        console.error(`[run-script] Failed to reject: ${errorDetails}`)
        return c.json({ error: 'Failed to reject script run request' }, 500)
      }

      trackServerEvent('request_declined', { type: 'script_run', withReason: !!declineReason })
      return c.json({ success: true, declined: true })
    }

    // Run path: validate platform, execute script
    // Permission is now managed by ComputerUsePermissionManager (use_host_shell level)
    // The permission grant happens when the user clicks "Allow" in the UI
    const { VALID_SCRIPT_TYPES } = await import('@shared/lib/config/settings')

    // Record permission grant if grantType is provided
    if (body.grantType && ['once', 'timed', 'always'].includes(body.grantType)) {
      const { computerUsePermissionManager } = await import('@shared/lib/computer-use/permission-manager')
      computerUsePermissionManager.grantPermission(agentSlug, 'use_host_shell', body.grantType)
    }

    if (!script || !scriptType) {
      return c.json({ error: 'script and scriptType are required' }, 400)
    }

    // Validate scriptType against platform
    const platform = process.platform
    if (!VALID_SCRIPT_TYPES[platform]?.includes(scriptType)) {
      return c.json({ error: `Script type "${scriptType}" is not supported on ${platform}` }, 400)
    }

    // Execute the script with a 30s timeout
    const { exec, execFile } = await import('child_process')
    const { promisify } = await import('util')
    const execAsync = promisify(exec)
    const execFileAsync = promisify(execFile)

    let stdout = ''
    let stderr = ''
    let exitCode = 0

    try {
      if (scriptType === 'applescript') {
        // Use execFile to avoid shell escaping issues with quotes/newlines.
        // Split into one -e arg per line (how osascript handles multi-line scripts).
        const lines = script.split('\n').filter((l: string) => l.trim())
        const args = lines.flatMap((line: string) => ['-e', line])
        const result = await execFileAsync('osascript', args, { timeout: 30000 })
        stdout = result.stdout || ''
        stderr = result.stderr || ''
      } else if (scriptType === 'shell') {
        const result = await execAsync(script, { timeout: 30000, shell: '/bin/zsh' })
        stdout = result.stdout || ''
        stderr = result.stderr || ''
      } else {
        // powershell — use execFile to avoid shell escaping issues
        const result = await execFileAsync('powershell.exe', ['-Command', script], { timeout: 30000 })
        stdout = result.stdout || ''
        stderr = result.stderr || ''
      }
    } catch (execError: any) {
      stdout = execError.stdout || ''
      stderr = execError.stderr || ''
      exitCode = execError.code ?? 1
    }

    // Format output for the agent
    const output = [
      `Exit code: ${exitCode}`,
      stdout ? `stdout:\n${stdout}` : '',
      stderr ? `stderr:\n${stderr}` : '',
    ].filter(Boolean).join('\n\n')

    // Resolve the pending input
    const resolveResponse = await client.fetch(
      `/inputs/${encodeURIComponent(toolUseId)}/resolve`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: output }),
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
      console.error(`[run-script] Failed to resolve: ${errorDetails}`)
      return c.json({ error: 'Failed to resolve script run request' }, 500)
    }

    trackServerEvent('script_executed', { scriptType, exitCode })
    return c.json({ success: true })
  } catch (error) {
    console.error('Failed to run script:', error)
    return c.json({ error: 'Failed to run script' }, 500)
  }
})

// POST /api/agents/:id/sessions/:sessionId/computer-use - Execute or deny a computer use request
agents.post('/:id/sessions/:sessionId/computer-use', AgentUser(), async (c) => {
  try {
    const agentSlug = c.req.param('id')
    const sessionId = c.req.param('sessionId')
    const body = await c.req.json()
    const { toolUseId, method, params, permissionLevel, appName, grantType, decline, declineReason } = body

    if (!toolUseId) {
      return c.json({ error: 'toolUseId is required' }, 400)
    }

    // Validate session belongs to this agent (skip for _auto internal calls from auto-execute)
    if (sessionId !== '_auto') {
      const session = await getSession(agentSlug, sessionId)
      if (!session) {
        return c.json({ error: 'Session not found' }, 404)
      }
    }

    const client = containerManager.getClient(agentSlug)

    if (decline) {
      const reason = declineReason || 'User denied computer use request'

      const rejectResponse = await client.fetch(
        `/inputs/${encodeURIComponent(toolUseId)}/reject`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason }),
        }
      )

      if (!rejectResponse.ok) {
        let errorDetails = 'Unknown error'
        try {
          const error = await rejectResponse.json()
          errorDetails = JSON.stringify(error)
        } catch {
          errorDetails = await rejectResponse.text()
        }
        console.error(`[computer-use] Failed to reject: ${errorDetails}`)
        return c.json({ error: 'Failed to reject computer use request' }, 500)
      }

      messagePersister.clearPendingComputerUseRequest(sessionId, toolUseId)
      trackServerEvent('request_declined', { type: 'computer_use', method, withReason: !!declineReason })
      return c.json({ success: true, declined: true })
    }

    // Approve path: grant permission, execute, resolve
    if (!method) {
      return c.json({ error: 'method is required for execution' }, 400)
    }

    // In E2E mock mode, skip actual execution — just resolve the input directly
    if (process.env.E2E_MOCK === 'true') {
      const resolveResponse = await client.fetch(
        `/inputs/${encodeURIComponent(toolUseId)}/resolve`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: `[mock] ${method} executed successfully` }),
        }
      )
      if (!resolveResponse.ok) {
        return c.json({ error: 'Failed to resolve computer use request' }, 500)
      }
      messagePersister.clearPendingComputerUseRequest(sessionId, toolUseId)
      return c.json({ success: true })
    }

    // Check macOS permissions before executing
    const { executeComputerUseCommand, checkACPermissions } = await import('@shared/lib/computer-use/executor')
    const { resolveTargetApp } = await import('@shared/lib/computer-use/types')
    const missingPermissions = await checkACPermissions()
    if (missingPermissions) {
      return c.json({
        success: false,
        missingPermissions,
      }, 428)
    }

    // Record the permission grant
    const { computerUsePermissionManager } = await import('@shared/lib/computer-use/permission-manager')
    if (grantType && ['once', 'timed', 'always'].includes(grantType)) {
      computerUsePermissionManager.grantPermission(agentSlug, permissionLevel || 'use_application', grantType, appName)
    }

    // Execute the computer use command
    let output: string
    try {
      output = await executeComputerUseCommand(method, params || {})
    } catch (execError: unknown) {
      // Execution failed — reject the input so the agent sees it as a tool error
      const errorMsg = execError instanceof Error ? execError.message : String(execError)
      await client.fetch(
        `/inputs/${encodeURIComponent(toolUseId)}/reject`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: `Error executing ${method}: ${errorMsg}` }),
        }
      ).catch(() => {})
      messagePersister.clearPendingComputerUseRequest(sessionId, toolUseId)
      return c.json({ success: true, error: errorMsg })
    }

    // Track grab/ungrab state and broadcast to UI
    // Launch auto-grabs, so treat it like grab
    if (method === 'grab' || method === 'launch') {
      // Use appName from the request body (already resolved for grab-by-ref)
      // and fall back to resolveTargetApp for direct app name params
      const targetApp = appName || resolveTargetApp(method, params || {})
      if (targetApp) {
        computerUsePermissionManager.setGrabbedApp(agentSlug, targetApp)
        // Broadcast immediately with app name, then resolve icon async
        messagePersister.broadcastSessionEvent(sessionId, { type: 'computer_use_grab_changed', app: targetApp })
        const { getAppIconBase64 } = await import('@shared/lib/computer-use/app-icon')
        getAppIconBase64(targetApp).then((icon) => {
          if (icon) {
            messagePersister.broadcastSessionEvent(sessionId, { type: 'computer_use_grab_changed', app: targetApp, appIcon: icon })
          }
        }).catch(() => {})
      }
    } else if (method === 'ungrab' || method === 'quit') {
      computerUsePermissionManager.clearGrabbedApp(agentSlug)
      messagePersister.broadcastSessionEvent(sessionId, { type: 'computer_use_grab_changed', app: null })
    }

    // Consume "once" grant after use
    if (grantType === 'once') {
      computerUsePermissionManager.consumeOnceGrant(agentSlug, permissionLevel || 'use_application', appName)
    }

    // Resolve the pending input
    const resolveResponse = await client.fetch(
      `/inputs/${encodeURIComponent(toolUseId)}/resolve`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: output }),
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
      console.error(`[computer-use] Failed to resolve: ${errorDetails}`)
      return c.json({ error: 'Failed to resolve computer use request' }, 500)
    }

    messagePersister.clearPendingComputerUseRequest(sessionId, toolUseId)
    trackServerEvent('computer_use_executed', { method, permissionLevel, grantType })
    return c.json({ success: true })
  } catch (error) {
    console.error('Failed to execute computer use:', error)
    return c.json({ error: 'Failed to execute computer use' }, 500)
  }
})

// POST /api/agents/:id/sessions/:sessionId/computer-use/revoke - Ungrab window and revoke permission for the app
agents.post('/:id/sessions/:sessionId/computer-use/revoke', AgentUser(), async (c) => {
  try {
    const agentSlug = c.req.param('id')
    const sessionId = c.req.param('sessionId')

    const session = await getSession(agentSlug, sessionId)
    if (!session) {
      return c.json({ error: 'Session not found' }, 404)
    }

    const { computerUsePermissionManager } = await import('@shared/lib/computer-use/permission-manager')

    const appName = computerUsePermissionManager.getGrabbedApp(agentSlug)

    // Ungrab via AC
    const { ungrabAC } = await import('@shared/lib/computer-use/executor')
    await ungrabAC()

    // Clear grab state
    computerUsePermissionManager.clearGrabbedApp(agentSlug)

    // Revoke use_application permission for this app
    if (appName) {
      computerUsePermissionManager.revokeGrant(agentSlug, 'use_application', appName)
    }

    // Broadcast to UI
    messagePersister.broadcastSessionEvent(sessionId, { type: 'computer_use_grab_changed', app: null })

    return c.json({ success: true, revoked: appName || true })
  } catch (error) {
    console.error('Failed to revoke computer use:', error)
    return c.json({ error: 'Failed to revoke computer use' }, 500)
  }
})

// GET /api/agents/:id/scheduled-tasks - List scheduled tasks for an agent
agents.get('/:id/scheduled-tasks', AgentRead(), async (c) => {
  try {
    const slug = c.req.param('id')
    const status = c.req.query('status') // Optional: filter by status (e.g., 'pending')


    let tasks
    if (status === 'pending') {
      tasks = await listPendingScheduledTasks(slug)
    } else if (status === 'cancelled') {
      tasks = await listCancelledScheduledTasks(slug)
    } else {
      tasks = await listScheduledTasks(slug)
    }

    return c.json(tasks)
  } catch (error) {
    console.error('Failed to fetch scheduled tasks:', error)
    return c.json({ error: 'Failed to fetch scheduled tasks' }, 500)
  }
})

// GET /api/agents/:id/webhook-triggers - List webhook triggers for an agent
agents.get('/:id/webhook-triggers', AgentRead(), async (c) => {
  try {
    const slug = c.req.param('id')
    const status = c.req.query('status')

    const triggers = status === 'active'
      ? await listActiveWebhookTriggers(slug)
      : status === 'cancelled'
      ? await listCancelledWebhookTriggers(slug)
      : await listWebhookTriggers(slug)
    return c.json(triggers)
  } catch (error) {
    console.error('Failed to fetch webhook triggers:', error)
    return c.json({ error: 'Failed to fetch webhook triggers' }, 500)
  }
})

// GET /api/agents/:id/secrets - List secrets for an agent
agents.get('/:id/secrets', AgentRead(), async (c) => {
  try {
    const slug = c.req.param('id')


    const secrets = await listSecrets(slug)
    const response = secrets.map((secret) => ({
      id: secret.envVar,
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
agents.post('/:id/secrets', AgentUser(), async (c) => {
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

    return c.json({ id: envVar, key: key.trim(), envVar, hasValue: true }, 201)
  } catch (error) {
    console.error('Failed to create secret:', error)
    return c.json({ error: 'Failed to create secret' }, 500)
  }
})

// PUT /api/agents/:id/secrets/:secretId - Update a secret
agents.put('/:id/secrets/:secretId', AgentUser(), async (c) => {
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

    return c.json({ id: newEnvVar, key: newKey, envVar: newEnvVar, hasValue: true })
  } catch (error) {
    console.error('Failed to update secret:', error)
    return c.json({ error: 'Failed to update secret' }, 500)
  }
})

// DELETE /api/agents/:id/secrets/:secretId - Delete a secret
agents.delete('/:id/secrets/:secretId', AgentUser(), async (c) => {
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
agents.get('/:id/connected-accounts', AgentRead(), async (c) => {
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
agents.post('/:id/connected-accounts', AgentUser(), async (c) => {
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

    // Verify ownership of accounts in auth mode
    const userId = getCurrentUserId(c)
    const ownedAccounts = await db
      .select()
      .from(connectedAccounts)
      .where(and(
        inArray(connectedAccounts.id, accountIds),
        isAuthMode() ? eq(connectedAccounts.userId, userId) : undefined
      ))
    const ownedAccountIds = new Set(ownedAccounts.map(a => a.id))
    const validAccountIds = accountIds.filter(id => ownedAccountIds.has(id))

    if (validAccountIds.length === 0) {
      return c.json({ error: 'No valid accounts found' }, 400)
    }

    const now = new Date()
    const newMappings = validAccountIds.map((accountId) => ({
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
agents.delete('/:id/connected-accounts/:accountId', AgentUser(), async (c) => {
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
agents.get('/:id/remote-mcps', AgentRead(), async (c) => {
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
agents.post('/:id/remote-mcps', AgentUser(), async (c) => {
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
agents.delete('/:id/remote-mcps/:mcpId', AgentUser(), async (c) => {
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
agents.post('/:id/sessions/:sessionId/provide-remote-mcp', AgentUser(), async (c) => {
  try {
    const slug = c.req.param('id')
    const body = await c.req.json<{
      toolUseId: string
      remoteMcpId?: string
      remoteMcpIds?: string[]
      decline?: boolean
      declineReason?: string
    }>()
    const requestedMcpIds = Array.from(
      new Set((body.remoteMcpIds && body.remoteMcpIds.length > 0 ? body.remoteMcpIds : body.remoteMcpId ? [body.remoteMcpId] : []).filter(Boolean))
    )

    if (!body.toolUseId) {
      return c.json({ error: 'toolUseId is required' }, 400)
    }
    if (!body.decline && requestedMcpIds.length === 0) {
      return c.json({ error: 'remoteMcpId or remoteMcpIds is required when not declining' }, 400)
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
      trackServerEvent('request_declined', { type: 'remote_mcp', withReason: !!body.declineReason })
      return c.json({ success: true, status: 'declined' })
    }

    // Map MCP to agent if not already mapped
    const existingMapping = await db
      .select()
      .from(agentRemoteMcps)
      .where(
        and(
          eq(agentRemoteMcps.agentSlug, slug),
          inArray(agentRemoteMcps.remoteMcpId, requestedMcpIds)
        )
      )
    const existingMappedIds = new Set(existingMapping.map((mapping) => mapping.remoteMcpId))

    const newMappings = requestedMcpIds
      .filter((mcpId) => !existingMappedIds.has(mcpId))
      .map((mcpId) => ({
        id: crypto.randomUUID(),
        agentSlug: slug,
        remoteMcpId: mcpId,
        createdAt: new Date(),
      }))

    if (newMappings.length > 0) {
      await db.insert(agentRemoteMcps).values(newMappings)
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
      .map(({ mcp }) => {
        // Only pass tool names (not full schemas) to keep env var size small
        let toolNames: Array<{ name: string }> = []
        if (mcp.toolsJson) {
          try { toolNames = JSON.parse(mcp.toolsJson).map((t: any) => ({ name: t.name })) } catch { /* ignore */ }
        }
        return {
          id: mcp.id,
          name: mcp.name,
          proxyUrl: `http://${hostUrl}:${appPort}/api/mcp-proxy/${slug}/${mcp.id}`,
          tools: toolNames,
        }
      })

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
      body: JSON.stringify({ value: requestedMcpIds }),
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
agents.get('/:id/mcp-audit-log', AgentAdmin(), async (c) => {
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
agents.get('/:id/skills', AgentRead(), async (c) => {
  try {
    const id = c.req.param('id')
    const scope = getSkillsetScope()
    const skills = await getAgentSkillsWithStatus(id, scope.allSkillsets, {
      currentPlatformOrgId: scope.currentPlatformOrgId,
    })
    return c.json({ skills })
  } catch (error) {
    console.error('Failed to fetch skills:', error)
    return c.json({ error: 'Failed to fetch skills' }, 500)
  }
})

// GET /api/agents/:id/discoverable-skills - Get available skills from skillsets
agents.get('/:id/discoverable-skills', AgentRead(), async (c) => {
  try {
    const id = c.req.param('id')
    const scope = getSkillsetScope()
    const skills = await getDiscoverableSkills(id, scope.visibleSkillsets)
    return c.json({ skills })
  } catch (error) {
    console.error('Failed to fetch discoverable skills:', error)
    return c.json({ error: 'Failed to fetch discoverable skills' }, 500)
  }
})

// POST /api/agents/:id/skills/install - Install a skill from a skillset
agents.post('/:id/skills/install', AgentAdmin(), async (c) => {
  try {
    const agentSlug = c.req.param('id')
    const { skillsetId, skillPath, skillName, skillVersion, envVars } = await c.req.json()

    if (!skillsetId || !skillPath) {
      return c.json({ error: 'skillsetId and skillPath are required' }, 400)
    }

    // Find the skillset config
    const scope = getSkillsetScope()
    const config = findVisibleSkillsetById(scope, skillsetId)
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
      config.provider,
      config.platformRepoId,
      config.name,
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
agents.post('/:id/skills/:dir/update', AgentAdmin(), async (c) => {
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
agents.get('/:id/skills/:dir/pr-info', AgentAdmin(), async (c) => {
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
agents.post('/:id/skills/:dir/create-pr', AgentAdmin(), async (c) => {
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
agents.get('/:id/skills/:dir/publish-info', AgentAdmin(), async (c) => {
  try {
    const agentSlug = c.req.param('id')
    const skillDir = c.req.param('dir')
    const skillsetId = c.req.query('skillsetId')

    if (!skillsetId) {
      return c.json({ error: 'skillsetId query parameter is required' }, 400)
    }

    const scope = getSkillsetScope()
    const config = findVisibleSkillsetById(scope, skillsetId)
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
agents.post('/:id/skills/:dir/publish', AgentAdmin(), async (c) => {
  try {
    const agentSlug = c.req.param('id')
    const skillDir = c.req.param('dir')
    const { skillsetId, title, body, newVersion } = await c.req.json()

    if (!skillsetId || !title || !body) {
      return c.json({ error: 'skillsetId, title, and body are required' }, 400)
    }

    const scope = getSkillsetScope()
    const config = findVisibleSkillsetById(scope, skillsetId)
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
agents.post('/:id/export-template', AgentAdmin(), async (c) => {
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

// POST /api/agents/:id/export-full - Export full agent as ZIP download (includes .env, data, etc.)
agents.post('/:id/export-full', AgentAdmin(), async (c) => {
  try {
    const slug = c.req.param('id')
    const zipBuffer = await exportAgentFull(slug)

    return new Response(new Uint8Array(zipBuffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${slug}-full.zip"`,
        'Content-Length': zipBuffer.byteLength.toString(),
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to export agent'
    console.error('Failed to export full agent:', error)
    return c.json({ error: message }, 500)
  }
})

// GET /api/agents/:id/template-status - Get skillset status
agents.get('/:id/template-status', AgentRead(), async (c) => {
  try {
    const slug = c.req.param('id')
    const scope = getSkillsetScope()
    const status = await getAgentTemplateStatus(slug, scope.allSkillsets, {
      currentPlatformOrgId: scope.currentPlatformOrgId,
    })
    return c.json(status)
  } catch (error) {
    console.error('Failed to get template status:', error)
    return c.json({ error: 'Failed to get template status' }, 500)
  }
})

// POST /api/agents/:id/template-update - Update from skillset
agents.post('/:id/template-update', AgentAdmin(), async (c) => {
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
agents.get('/:id/template-pr-info', AgentRead(), async (c) => {
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
agents.post('/:id/template-create-pr', AgentAdmin(), async (c) => {
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
agents.get('/:id/template-publish-info', AgentRead(), async (c) => {
  try {
    const slug = c.req.param('id')
    const skillsetId = c.req.query('skillsetId')

    if (!skillsetId) {
      return c.json({ error: 'skillsetId query parameter is required' }, 400)
    }

    const scope = getSkillsetScope()
    const config = findVisibleSkillsetById(scope, skillsetId)
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
agents.post('/:id/template-publish', AgentAdmin(), async (c) => {
  try {
    const slug = c.req.param('id')
    const { skillsetId, title, body, newVersion } = await c.req.json()

    if (!skillsetId || !title || !body) {
      return c.json({ error: 'skillsetId, title, and body are required' }, 400)
    }

    const scope = getSkillsetScope()
    const config = findVisibleSkillsetById(scope, skillsetId)
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
agents.post('/:id/template-refresh', AgentUser(), async (c) => {
  try {
    const scope = getSkillsetScope()
    await refreshAgentTemplates(scope.visibleSkillsets)
    const slug = c.req.param('id')
    const status = await getAgentTemplateStatus(slug, scope.allSkillsets, {
      currentPlatformOrgId: scope.currentPlatformOrgId,
    })
    return c.json(status)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to refresh template'
    console.error('Failed to refresh template:', error)
    return c.json({ error: message }, 500)
  }
})

// POST /api/agents/:id/skills/refresh - Refresh skillset caches and reconcile skill status
agents.post('/:id/skills/refresh', AgentUser(), async (c) => {
  try {
    const agentSlug = c.req.param('id')
    const scope = getSkillsetScope()
    await refreshAgentSkills(agentSlug, scope.visibleSkillsets)
    const skills = await getAgentSkillsWithStatus(agentSlug, scope.allSkillsets, {
      currentPlatformOrgId: scope.currentPlatformOrgId,
    })
    return c.json({ skills })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to refresh skills'
    console.error('Failed to refresh skills:', error)
    return c.json({ error: message }, 500)
  }
})

// GET /api/agents/:id/skills/:dir/files - List all files in a skill directory
agents.get('/:id/skills/:dir/files', AgentAdmin(), async (c) => {
  try {
    const agentSlug = c.req.param('id')
    const dir = c.req.param('dir')

    if (!dir || dir.includes('/') || dir.includes('\\') || dir.includes('..')) {
      return c.json({ error: 'Invalid skill directory name' }, 400)
    }

    const skillDir = path.join(getAgentWorkspaceDir(agentSlug), '.claude', 'skills', dir)

    if (!fs.existsSync(skillDir)) {
      return c.json({ error: 'Skill directory not found' }, 404)
    }

    const files: Array<{ path: string; type: 'file' | 'directory' }> = []

    const walk = async (currentDir: string, prefix: string) => {
      const entries = await fs.promises.readdir(currentDir, { withFileTypes: true })
      for (const entry of entries) {
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
        if (entry.isDirectory()) {
          files.push({ path: relativePath, type: 'directory' })
          await walk(path.join(currentDir, entry.name), relativePath)
        } else {
          files.push({ path: relativePath, type: 'file' })
        }
      }
    }

    await walk(skillDir, '')
    files.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
      return a.path.localeCompare(b.path)
    })

    return c.json({ files })
  } catch (error) {
    console.error('Failed to list skill files:', error)
    return c.json({ error: 'Failed to list skill files' }, 500)
  }
})

// GET /api/agents/:id/skills/:dir/files/content - Read a skill file
agents.get('/:id/skills/:dir/files/content', AgentAdmin(), async (c) => {
  try {
    const agentSlug = c.req.param('id')
    const dir = c.req.param('dir')
    const filePath = c.req.query('path')

    if (!dir || dir.includes('/') || dir.includes('\\') || dir.includes('..')) {
      return c.json({ error: 'Invalid skill directory name' }, 400)
    }
    if (!filePath) {
      return c.json({ error: 'path query parameter is required' }, 400)
    }

    const skillDir = path.join(getAgentWorkspaceDir(agentSlug), '.claude', 'skills', dir)
    const resolved = path.resolve(skillDir, filePath)

    if (!resolved.startsWith(skillDir + path.sep) && resolved !== skillDir) {
      return c.json({ error: 'Invalid file path' }, 400)
    }

    const content = await fs.promises.readFile(resolved, 'utf-8')
    return c.json({ content, path: filePath })
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return c.json({ error: 'File not found' }, 404)
    }
    console.error('Failed to read skill file:', error)
    return c.json({ error: 'Failed to read skill file' }, 500)
  }
})

// PUT /api/agents/:id/skills/:dir/files/content - Write a skill file
agents.put('/:id/skills/:dir/files/content', AgentAdmin(), async (c) => {
  try {
    const agentSlug = c.req.param('id')
    const dir = c.req.param('dir')
    const { path: filePath, content } = await c.req.json()

    if (!dir || dir.includes('/') || dir.includes('\\') || dir.includes('..')) {
      return c.json({ error: 'Invalid skill directory name' }, 400)
    }
    if (!filePath || typeof content !== 'string') {
      return c.json({ error: 'path and content are required' }, 400)
    }

    const skillDir = path.join(getAgentWorkspaceDir(agentSlug), '.claude', 'skills', dir)
    const resolved = path.resolve(skillDir, filePath)

    if (!resolved.startsWith(skillDir + path.sep) && resolved !== skillDir) {
      return c.json({ error: 'Invalid file path' }, 400)
    }

    await fs.promises.writeFile(resolved, content, 'utf-8')
    return c.json({ saved: true })
  } catch (error) {
    console.error('Failed to write skill file:', error)
    return c.json({ error: 'Failed to write skill file' }, 500)
  }
})

// GET /api/agents/:id/audit-log - Get combined proxy + MCP audit log for agent
agents.get('/:id/audit-log', AgentAdmin(), async (c) => {
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
        policyDecision: e.policyDecision ?? null,
        matchedScopes: e.matchedScopes ?? null,
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
        policyDecision: e.policyDecision ?? null,
        matchedScopes: e.matchedTool ? JSON.stringify([e.matchedTool]) : null,
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
async function handleFileUpload(agentSlug: string, file: File, relativePath?: string) {
  const filename = file.name

  // If relativePath is provided (folder upload), preserve directory structure
  let uploadPath: string
  if (relativePath) {
    const normalized = path.normalize(relativePath).replace(/^(\.\.[/\\])+/, '')
    uploadPath = `uploads/${normalized}`
  } else {
    uploadPath = `uploads/${Date.now()}-${filename}`
  }

  const workspaceDir = getAgentWorkspaceDir(agentSlug)
  const fullPath = path.resolve(workspaceDir, uploadPath)

  // Security: ensure path doesn't escape the uploads directory
  if (!fullPath.startsWith(path.resolve(workspaceDir, 'uploads'))) {
    throw new Error('Invalid file path')
  }

  const arrayBuffer = await file.arrayBuffer()
  const buffer = Buffer.from(arrayBuffer)

  // Write directly to host filesystem (volume-mounted into container)
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
agents.post('/:id/upload-file', AgentUser(), async (c) => {
  try {
    const agentSlug = c.req.param('id')


    const formData = await c.req.formData()
    const file = formData.get('file') as File | null
    const relativePath = formData.get('relativePath') as string | null

    if (!file) {
      return c.json({ error: 'No file provided' }, 400)
    }

    const result = await handleFileUpload(agentSlug, file, relativePath || undefined)
    return c.json(result)
  } catch (error) {
    console.error('Failed to upload file:', error)
    return c.json({ error: 'Failed to upload file' }, 500)
  }
})

// POST /api/agents/:id/sessions/:sessionId/upload-file - Upload a file to the agent workspace
agents.post('/:id/sessions/:sessionId/upload-file', AgentUser(), async (c) => {
  try {
    const agentSlug = c.req.param('id')


    const formData = await c.req.formData()
    const file = formData.get('file') as File | null
    const relativePath = formData.get('relativePath') as string | null

    if (!file) {
      return c.json({ error: 'No file provided' }, 400)
    }

    const result = await handleFileUpload(agentSlug, file, relativePath || undefined)
    return c.json(result)
  } catch (error) {
    console.error('Failed to upload file:', error)
    return c.json({ error: 'Failed to upload file' }, 500)
  }
})

async function handleFolderUpload(agentSlug: string, sourcePath: string) {
  const stat = await fs.promises.stat(sourcePath)
  if (!stat.isDirectory()) {
    throw new Error('Source is not a directory')
  }

  const folderName = path.basename(sourcePath)
  const workspaceDir = getAgentWorkspaceDir(agentSlug)
  const destPath = path.resolve(workspaceDir, 'uploads', folderName)

  // Security: ensure dest doesn't escape uploads directory
  if (!destPath.startsWith(path.resolve(workspaceDir, 'uploads'))) {
    throw new Error('Invalid path')
  }

  await fs.promises.mkdir(path.dirname(destPath), { recursive: true })
  await fs.promises.cp(sourcePath, destPath, { recursive: true })

  return {
    success: true,
    path: `/workspace/uploads/${folderName}/`,
    folderName,
  }
}

// POST /api/agents/:id/upload-folder - Copy a local folder to the agent workspace (Electron only)
agents.post('/:id/upload-folder', AgentUser(), async (c) => {
  try {
    const agentSlug = c.req.param('id')
    const { sourcePath } = await c.req.json<{ sourcePath: string }>()
    if (!sourcePath) return c.json({ error: 'No source path provided' }, 400)
    const result = await handleFolderUpload(agentSlug, sourcePath)
    return c.json(result)
  } catch (error) {
    console.error('Failed to upload folder:', error)
    return c.json({ error: 'Failed to upload folder' }, 500)
  }
})

// POST /api/agents/:id/sessions/:sessionId/upload-folder - Copy a local folder to the agent workspace (Electron only)
agents.post('/:id/sessions/:sessionId/upload-folder', AgentUser(), async (c) => {
  try {
    const agentSlug = c.req.param('id')
    const { sourcePath } = await c.req.json<{ sourcePath: string }>()
    if (!sourcePath) return c.json({ error: 'No source path provided' }, 400)
    const result = await handleFolderUpload(agentSlug, sourcePath)
    return c.json(result)
  } catch (error) {
    console.error('Failed to upload folder:', error)
    return c.json({ error: 'Failed to upload folder' }, 500)
  }
})

// --- Mount CRUD endpoints ---

// GET /api/agents/:id/mounts - List mounts with health status
agents.get('/:id/mounts', AgentRead(), async (c) => {
  try {
    const agentSlug = c.req.param('id')
    const mounts = getMountsWithHealth(agentSlug)
    return c.json(mounts)
  } catch (error) {
    console.error('Failed to list mounts:', error)
    return c.json({ error: 'Failed to list mounts' }, 500)
  }
})

// POST /api/agents/:id/mounts - Add a mount
agents.post('/:id/mounts', AgentUser(), async (c) => {
  try {
    const agentSlug = c.req.param('id')
    const { hostPath, restart } = await c.req.json<{ hostPath: string; restart?: boolean }>()
    if (!hostPath) return c.json({ error: 'hostPath is required' }, 400)

    let mount
    try {
      mount = addMount(agentSlug, hostPath)
    } catch (err: any) {
      return c.json({ error: err.message || 'Invalid path' }, 400)
    }

    if (restart) {
      const cachedInfo = containerManager.getCachedInfo(agentSlug)
      if (cachedInfo.status === 'running') {
        await containerManager.restartContainer(agentSlug)
      }
    }

    return c.json(mount, 201)
  } catch (error) {
    console.error('Failed to add mount:', error)
    return c.json({ error: 'Failed to add mount' }, 500)
  }
})

// DELETE /api/agents/:id/mounts/:mountId - Remove a mount
agents.delete('/:id/mounts/:mountId', AgentUser(), async (c) => {
  try {
    const agentSlug = c.req.param('id')
    const mountId = c.req.param('mountId')
    const restart = c.req.query('restart') === 'true'

    removeMount(agentSlug, mountId)

    if (restart) {
      const cachedInfo = containerManager.getCachedInfo(agentSlug)
      if (cachedInfo.status === 'running') {
        await containerManager.restartContainer(agentSlug)
      }
    }

    return c.json({ success: true })
  } catch (error) {
    console.error('Failed to remove mount:', error)
    return c.json({ error: 'Failed to remove mount' }, 500)
  }
})

// GET /api/agents/:id/files/* - Download a file from the agent workspace
agents.get('/:id/files/*', AgentRead(), async (c) => {
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
agents.post('/:id/sessions/:sessionId/provide-file', AgentUser(), async (c) => {
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

      trackServerEvent('request_declined', { type: 'file', withReason: !!declineReason })
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
agents.get('/:id/artifacts', AgentRead(), async (c) => {
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

// DELETE /api/agents/:id/artifacts/:artifactSlug - Delete a dashboard
agents.delete('/:id/artifacts/:artifactSlug', AgentAdmin(), async (c) => {
  try {
    const agentSlug = c.req.param('id')
    const artifactSlug = c.req.param('artifactSlug')

    // Stop the dashboard process in the container (if running), then delete files
    try {
      const client = containerManager.getClient(agentSlug)
      const info = containerManager.getCachedInfo(agentSlug)
      if (info.status === 'running') {
        await client.fetch(`/artifacts/${encodeURIComponent(artifactSlug)}`, { method: 'DELETE' })
      }
    } catch {
      // Container not running — just delete files
    }

    await deleteArtifactFromFilesystem(agentSlug, artifactSlug)
    return c.body(null, 204)
  } catch (error) {
    console.error('Failed to delete artifact:', error)
    return c.json({ error: 'Failed to delete artifact' }, 500)
  }
})

// PATCH /api/agents/:id/artifacts/:artifactSlug - Rename a dashboard
agents.patch('/:id/artifacts/:artifactSlug', AgentAdmin(), async (c) => {
  try {
    const agentSlug = c.req.param('id')
    const artifactSlug = c.req.param('artifactSlug')
    const { name } = await c.req.json()

    if (!name || typeof name !== 'string' || !name.trim()) {
      return c.json({ error: 'Name is required' }, 400)
    }

    await renameArtifactOnFilesystem(agentSlug, artifactSlug, name.trim())
    return c.json({ ok: true })
  } catch (error) {
    console.error('Failed to rename artifact:', error)
    return c.json({ error: 'Failed to rename artifact' }, 500)
  }
})

// GET /api/agents/:id/artifacts/:artifactSlug/view - Standalone dashboard wrapper
// Serves a self-contained HTML page that handles agent lifecycle (auto-start, wait, then load dashboard)
agents.get('/:id/artifacts/:artifactSlug/view', AgentRead(), async (c) => {
  const agentSlug = c.req.param('id')
  const artifactSlug = c.req.param('artifactSlug')
  const basePath = `/api/agents/${agentSlug}`

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Loading dashboard…</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0a0a0a; color: #e5e5e5; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .container { text-align: center; max-width: 400px; padding: 2rem; }
    .spinner { width: 40px; height: 40px; border: 3px solid #333; border-top-color: #888; border-radius: 50%; animation: spin 0.8s linear infinite; margin: 0 auto 1.5rem; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .status { font-size: 14px; color: #999; margin-top: 0.5rem; }
    .error { color: #ef4444; }
    iframe { position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; border: 0; }
  </style>
</head>
<body>
  <div class="container" id="loading">
    <div class="spinner"></div>
    <div id="status" class="status">Checking agent status…</div>
  </div>
  <script>
    const agentSlug = ${JSON.stringify(agentSlug)};
    const artifactSlug = ${JSON.stringify(artifactSlug)};
    const basePath = ${JSON.stringify(basePath)};
    const dashboardUrl = basePath + '/artifacts/' + encodeURIComponent(artifactSlug) + '/';
    const statusEl = document.getElementById('status');
    const loadingEl = document.getElementById('loading');

    function setTitle(name) {
      document.title = (name || artifactSlug) + ' \\u2014 SuperAgent';
    }

    async function fetchDashboardName() {
      try {
        const res = await fetch(basePath + '/artifacts');
        if (res.ok) {
          const artifacts = await res.json();
          const d = Array.isArray(artifacts) && artifacts.find(a => a.slug === artifactSlug);
          if (d && d.name) { setTitle(d.name); return d.name; }
        }
      } catch {}
      return null;
    }

    async function run() {
      try {
        // 1. Resolve dashboard name (works even when agent is stopped)
        await fetchDashboardName();

        // 2. Check agent status
        const agentRes = await fetch(basePath);
        if (!agentRes.ok) { throw new Error('Failed to fetch agent info'); }
        const agent = await agentRes.json();

        if (agent.status !== 'running') {
          // 3. Start the agent
          statusEl.textContent = 'Starting agent…';
          const startRes = await fetch(basePath + '/start', { method: 'POST' });
          if (!startRes.ok) {
            const err = await startRes.json().catch(() => ({}));
            throw new Error(err.error || 'Failed to start agent');
          }
        }

        // 4. Poll until dashboard is running
        statusEl.textContent = 'Waiting for dashboard…';
        await pollDashboard();

        // 5. Show the dashboard
        loadingEl.remove();
        const iframe = document.createElement('iframe');
        iframe.src = dashboardUrl;
        iframe.sandbox = 'allow-scripts allow-same-origin allow-forms allow-popups';
        document.body.appendChild(iframe);
      } catch (err) {
        statusEl.textContent = err.message;
        statusEl.classList.add('error');
      }
    }

    async function pollDashboard() {
      for (let i = 0; i < 120; i++) {
        const res = await fetch(basePath + '/artifacts');
        if (res.ok) {
          const artifacts = await res.json();
          const d = Array.isArray(artifacts) && artifacts.find(a => a.slug === artifactSlug);
          if (d && d.status === 'running') { setTitle(d.name); return; }
        }
        await new Promise(r => setTimeout(r, 1000));
      }
      throw new Error('Dashboard did not start in time');
    }

    run();
  </script>
</body>
</html>`

  return c.html(html)
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
  // eslint-disable-next-line local-rules/no-unhandled-throwing-builtins -- c.req.url is always a valid URL
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
agents.all('/:id/artifacts/:artifactSlug/*', AgentRead(), async (c) => {
  try {
    return await proxyArtifactRequest(c)
  } catch (error: any) {
    console.error('Failed to proxy artifact:', error)
    return c.json({ error: error.message || 'Failed to proxy artifact' }, 502)
  }
})

// Also handle without trailing path
agents.all('/:id/artifacts/:artifactSlug', AgentRead(), async (c) => {
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
agents.get('/:id/browser/status', AgentRead(), async (c) => {
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
agents.post('/:id/browser/:action', AgentUser(), async (c) => {
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

// ============================================================================
// Cleanup stale chunked uploads (older than 1 hour)
// ============================================================================
const STALE_UPLOAD_MS = 60 * 60 * 1000 // 1 hour

async function cleanupStaleUploads() {
  try {
    const uploadsDir = getTempUploadsDir()
    const entries = await fs.promises.readdir(uploadsDir, { withFileTypes: true }).catch(() => [])
    const now = Date.now()
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dirPath = path.join(uploadsDir, entry.name)
      const stat = await fs.promises.stat(dirPath).catch(() => null)
      if (stat && now - stat.mtimeMs > STALE_UPLOAD_MS) {
        await removeDirectory(dirPath).catch(() => {})
      }
    }
  } catch {
    // Ignore cleanup errors
  }
}

// Run cleanup on startup and every 30 minutes
cleanupStaleUploads()
setInterval(cleanupStaleUploads, 30 * 60 * 1000).unref()

// =============================================================================
// Proxy review endpoints
// =============================================================================

// GET /api/agents/:id/proxy-reviews - List pending reviews for this agent
agents.get('/:id/proxy-reviews', AgentRead(), async (c) => {
  const slug = c.req.param('id')
  const reviews = reviewManager.getPendingReviewsForAgent(slug)
  return c.json({ reviews })
})

// POST /api/agents/:id/proxy-review/:reviewId - Submit a review decision
agents.post('/:id/proxy-review/:reviewId', AgentUser(), async (c) => {
  const reviewId = c.req.param('reviewId')
  const body = await c.req.json<{ decision: 'allow' | 'deny' }>()

  if (!body.decision || !['allow', 'deny'].includes(body.decision)) {
    return c.json({ error: 'Invalid decision. Must be "allow" or "deny".' }, 400)
  }

  const success = reviewManager.submitDecision(reviewId, body.decision)
  if (!success) {
    return c.json({ error: 'Review not found or already resolved' }, 404)
  }

  return c.json({ ok: true })
})

// POST /api/agents/:id/proxy-review/:reviewId/always - Submit decision and save as policy
agents.post('/:id/proxy-review/:reviewId/always', AgentUser(), async (c) => {
  const reviewId = c.req.param('reviewId')
  const slug = c.req.param('id')
  const body = await c.req.json<{
    decision: 'allow' | 'deny'
    scope: string
    accountId: string
  }>()

  if (!body.decision || !['allow', 'deny'].includes(body.decision)) {
    return c.json({ error: 'Invalid decision' }, 400)
  }

  // Verify account ownership before saving policy
  if (body.accountId && isAuthMode()) {
    const userId = getCurrentUserId(c)
    const [acct] = await db
      .select({ userId: connectedAccounts.userId })
      .from(connectedAccounts)
      .where(eq(connectedAccounts.id, body.accountId))
      .limit(1)
    if (acct && acct.userId !== userId) {
      return c.json({ error: 'Forbidden: you do not own this account' }, 403)
    }
  }

  // Save the scope policy (may fail if account doesn't exist, e.g. in mock/E2E)
  const policyDecision = body.decision === 'allow' ? 'allow' : 'block'
  const now = new Date()
  try {
    await db.insert(apiScopePolicies).values({
      id: randomUUID(),
      accountId: body.accountId,
      scope: body.scope,
      decision: policyDecision,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: [apiScopePolicies.accountId, apiScopePolicies.scope],
      set: { decision: policyDecision, updatedAt: now },
    })
  } catch (err) {
    console.warn('Failed to save scope policy (account may not exist):', err)
  }

  // Submit decision for this review
  reviewManager.submitDecision(reviewId, body.decision)

  // Resolve all pending reviews for this agent that match the scope
  reviewManager.resolveMatchingPending(slug, body.scope, body.decision)

  return c.json({ ok: true })
})

export default agents
