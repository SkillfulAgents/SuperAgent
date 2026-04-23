/**
 * X-Agent Work routes
 *
 * Container-to-host endpoints for cross-agent operations (create / list /
 * invoke / read sessions). Mounted under /api/x-agent (separate from /api/agents
 * to avoid the /:id middleware that requires an existing agent slug in the URL).
 *
 * Auth: every request must carry the calling agent's proxy token via Authorization:
 * Bearer <token>. The route resolves the caller's agent slug from that token and
 * applies xAgentPolicies + ACLs accordingly.
 */

import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { randomUUID } from 'crypto'
import { and, eq } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { agentAcl } from '@shared/lib/db/schema'
import { isAuthMode } from '@shared/lib/auth/mode'
import { hasMinRole, type AgentRole } from '@shared/lib/types/agent'
import { validateProxyToken } from '@shared/lib/proxy/token-store'
import {
  createAgent,
  listAgents,
  getAgent,
} from '@shared/lib/services/agent-service'
import {
  listSessions,
  getSessionMessagesWithCompact,
  getSessionMetadata,
  registerSession,
  updateSessionMetadata,
} from '@shared/lib/services/session-service'
import { containerManager } from '@shared/lib/container/container-manager'
import { messagePersister } from '@shared/lib/container/message-persister'
import { reviewManager } from '@shared/lib/proxy/review-manager'
import {
  evaluate as evaluatePolicy,
  type XAgentOperation,
} from '@shared/lib/services/x-agent-policy-service'
import { getEffectiveModels, getEffectiveAgentLimits, getCustomEnvVars, getSettings } from '@shared/lib/config/settings'
import { getSecretEnvVars } from '@shared/lib/services/secrets-service'
import type { JsonlMessageEntry, JsonlSystemEntry } from '@shared/lib/types/agent'

// Typed context variables for the x-agent router. Using Hono's generic instead
// of `as never` casts gives us type safety on c.get/c.set.
type XAgentVariables = { callerSlug: string }

const xAgent = new Hono<{ Variables: XAgentVariables }>()

// ----------------------------------------------------------------------------
// Auth: resolve caller agent slug from Bearer token (proxy token)
// ----------------------------------------------------------------------------

xAgent.use('*', async (c, next) => {
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

// ----------------------------------------------------------------------------
// ACL helpers (auth mode)
// ----------------------------------------------------------------------------

/**
 * Find the owner-user IDs for a given agent. In auth mode, x-agent calls
 * carry the caller agent's owner perspective: the caller can only act on
 * targets the *owner* of the caller agent has access to.
 */
async function getOwnersOfAgent(agentSlug: string): Promise<string[]> {
  const rows = await db
    .select({ userId: agentAcl.userId })
    .from(agentAcl)
    .where(and(eq(agentAcl.agentSlug, agentSlug), eq(agentAcl.role, 'owner')))
  return rows.map((r) => r.userId)
}

/**
 * Check whether the caller agent's owner(s) hold at least `minRole` on `targetSlug`.
 * Returns true in non-auth mode (no ACL checks).
 */
async function callerOwnerHasRoleOnTarget(
  callerSlug: string,
  targetSlug: string,
  minRole: AgentRole,
): Promise<boolean> {
  if (!isAuthMode()) return true
  const callerOwners = await getOwnersOfAgent(callerSlug)
  if (callerOwners.length === 0) return false
  const aclRows = await db
    .select({ userId: agentAcl.userId, role: agentAcl.role })
    .from(agentAcl)
    .where(eq(agentAcl.agentSlug, targetSlug))
  for (const row of aclRows) {
    if (callerOwners.includes(row.userId) && hasMinRole(row.role as AgentRole, minRole)) {
      return true
    }
  }
  return false
}

/**
 * In auth mode, return the set of agent slugs the caller's owner(s) can
 * see (any role). In non-auth mode, returns null (= no filter).
 */
async function visibleAgentSlugs(callerSlug: string): Promise<Set<string> | null> {
  if (!isAuthMode()) return null
  const callerOwners = await getOwnersOfAgent(callerSlug)
  if (callerOwners.length === 0) return new Set()
  const owned = new Set<string>()
  for (const userId of callerOwners) {
    const rows = await db
      .select({ agentSlug: agentAcl.agentSlug })
      .from(agentAcl)
      .where(eq(agentAcl.userId, userId))
    for (const r of rows) owned.add(r.agentSlug)
  }
  return owned
}

// ----------------------------------------------------------------------------
// Policy + review helper
// ----------------------------------------------------------------------------

/**
 * Resolve the policy decision and run a review prompt if needed.
 * Returns { allowed: true } on allow, { allowed: false, reason } on block/deny.
 *
 * This helper does NOT persist anything. Persistence of "Allow always" decisions
 * happens in the UI-facing /api/agents/:id/proxy-review/:reviewId/always handler
 * (agents.ts), which writes the policy row before resolving the in-flight review.
 * Plain "Allow once" decisions go through /proxy-review/:reviewId and are not
 * remembered. 'create' is never persisted at all (spec: always re-prompt).
 */
async function checkAgentPolicy(
  callerSlug: string,
  operation: XAgentOperation | 'create',
  targetSlug: string | null,
  targetName: string,
  preview?: string,
): Promise<{ allowed: boolean; reason?: string }> {
  if (operation !== 'create') {
    const decision = evaluatePolicy(callerSlug, operation, targetSlug)
    if (decision === 'allow') return { allowed: true }
    if (decision === 'block') return { allowed: false, reason: 'Blocked by policy' }
    // 'review' → fall through to interactive prompt
  }

  try {
    const userDecision = await reviewManager.requestXAgentReview(
      callerSlug,
      targetSlug ?? '',
      targetName,
      operation,
      preview,
    )
    if (userDecision === 'deny') {
      return { allowed: false, reason: 'Denied by user' }
    }
    return { allowed: true }
  } catch (error) {
    return {
      allowed: false,
      reason: error instanceof Error ? error.message : 'Review failed',
    }
  }
}

// ----------------------------------------------------------------------------
// POST /api/x-agent/list - list agents visible to caller
// ----------------------------------------------------------------------------

xAgent.post('/list', async (c) => {
  const callerSlug = getCallerSlug(c)
  const policy = await checkAgentPolicy(callerSlug, 'list', null, 'all agents')
  if (!policy.allowed) {
    return c.json({ error: policy.reason ?? 'Forbidden' }, 403)
  }

  const visible = await visibleAgentSlugs(callerSlug)
  const all = await listAgents()
  const filtered = all
    .filter((a) => a.slug !== callerSlug)
    .filter((a) => (visible ? visible.has(a.slug) : true))
    .map((a) => ({
      slug: a.slug,
      name: a.frontmatter.name,
      description: a.frontmatter.description,
    }))
  return c.json({ agents: filtered })
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
  if (isAuthMode()) {
    const owners = await getOwnersOfAgent(callerSlug)
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
  }
  return c.json({ slug: agent.slug, name: agent.name })
})

// ----------------------------------------------------------------------------
// POST /api/x-agent/get-sessions - list sessions of a target agent
// ----------------------------------------------------------------------------

const getSessionsBodySchema = z.object({
  slug: z.string(),
})

xAgent.post('/get-sessions', zValidator('json', getSessionsBodySchema), async (c) => {
  const callerSlug = getCallerSlug(c)
  const { slug: targetSlug } = c.req.valid('json')

  const target = await getAgent(targetSlug)
  if (!target) return c.json({ error: 'Target agent not found' }, 404)

  if (!(await callerOwnerHasRoleOnTarget(callerSlug, targetSlug, 'viewer'))) {
    return c.json({ error: 'Forbidden: caller has no access to target agent' }, 403)
  }

  const policy = await checkAgentPolicy(callerSlug, 'read', targetSlug, target.frontmatter.name)
  if (!policy.allowed) {
    return c.json({ error: policy.reason ?? 'Forbidden' }, 403)
  }

  const sessions = await listSessions(targetSlug)
  return c.json({
    sessions: sessions.map((s) => ({
      id: s.id,
      name: s.name,
      createdAt: s.createdAt,
      lastActivityAt: s.lastActivityAt,
      messageCount: s.messageCount,
      isRunning: messagePersister.isSessionActive(s.id),
    })),
  })
})

// ----------------------------------------------------------------------------
// POST /api/x-agent/get-transcript - read transcript for a target session
// ----------------------------------------------------------------------------

const getTranscriptBodySchema = z.object({
  slug: z.string(),
  sessionId: z.string(),
  sync: z.boolean().optional(),
})

/**
 * Convert a JSONL message entry into a compact { role, content, toolName? } shape.
 * Strips internal SDK fields, keeps text and tool name only.
 */
function compactMessage(entry: JsonlMessageEntry | JsonlSystemEntry): {
  role: string
  content: string
  toolName?: string
} | null {
  if (entry.type === 'system') {
    if (entry.subtype === 'compact_boundary') {
      return { role: 'system', content: '[context compacted]' }
    }
    // Surface unknown system subtypes rather than silently dropping them — keeps
    // future SDK additions visible to invoking agents (and to debugging).
    return { role: 'system', content: `[system: ${entry.subtype ?? 'unknown'}]` }
  }
  const msg = entry.message
  if (typeof msg.content === 'string') {
    return { role: entry.type, content: msg.content }
  }
  // Array of content blocks: collapse text + summarize tool calls.
  // Thinking blocks are stripped (internal), but we track whether the turn
  // *only* had thinking so we can surface a placeholder rather than returning
  // empty content (which would otherwise look like "the agent didn't respond").
  const parts: string[] = []
  let firstToolName: string | undefined
  let hadThinking = false
  for (const block of msg.content) {
    if (block.type === 'text') {
      parts.push(block.text)
    } else if (block.type === 'tool_use') {
      firstToolName = firstToolName ?? block.name
      parts.push(`[tool_use: ${block.name}]`)
    } else if (block.type === 'tool_result') {
      const text = Array.isArray(block.content)
        ? block.content
            .filter((p) => p && typeof p === 'object' && 'text' in p)
            .map((p) => (p as { text: string }).text)
            .join('\n')
        : typeof block.content === 'string'
          ? block.content
          : ''
      parts.push(text ? `[tool_result] ${text}` : '[tool_result]')
    } else if (block.type === 'thinking') {
      hadThinking = true
    }
  }
  let content = parts.join('\n').trim()
  if (!content) {
    // Distinguish thinking-only turns from genuinely-empty turns so callers
    // (especially sync invoke's lastMessage) don't silently look "blank".
    content = hadThinking ? '[thinking only — no text response]' : '[no text response]'
  }
  return {
    role: entry.type,
    content,
    ...(firstToolName ? { toolName: firstToolName } : {}),
  }
}

/**
 * After a sync invoke, the SDK may emit 'result' (which clears isActive) before
 * the assistant message has been flushed to the JSONL file. Poll briefly so
 * we return the actual response, not the user prompt.
 *
 * Total wait: ~5s (10 × 500ms). Generous enough to absorb slow filesystems
 * (NFS, encrypted home, AV scanners) without keeping the HTTP handler open
 * indefinitely. Polling stops as soon as an assistant entry is found.
 *
 * Returns the compacted last assistant message, or null if no assistant entry
 * appears within the retry window. compactMessage always returns non-empty
 * content for assistant entries (placeholders for thinking-only / empty turns),
 * so a null return here specifically means "no assistant turn was persisted".
 */
// Tests can shrink the retry budget via env to keep timeouts snappy.
const READ_RETRY_ATTEMPTS = Number(process.env.X_AGENT_READ_RETRY_ATTEMPTS) || 10
const READ_RETRY_INTERVAL_MS = Number(process.env.X_AGENT_READ_RETRY_INTERVAL_MS) || 500

async function readLastAssistantMessage(
  targetSlug: string,
  sessionId: string,
  attempts = READ_RETRY_ATTEMPTS,
  intervalMs = READ_RETRY_INTERVAL_MS,
): Promise<{ role: string; content: string; toolName?: string } | null> {
  for (let i = 0; i < attempts; i++) {
    const entries = await getSessionMessagesWithCompact(targetSlug, sessionId)
    // Walk backwards to find the most recent assistant entry.
    for (let j = entries.length - 1; j >= 0; j--) {
      const e = entries[j]
      if (e.type !== 'assistant') continue
      const compact = compactMessage(e)
      if (compact) return compact
    }
    if (i < attempts - 1) {
      await new Promise((r) => setTimeout(r, intervalMs))
    }
  }
  return null
}

xAgent.post('/get-transcript', zValidator('json', getTranscriptBodySchema), async (c) => {
  const callerSlug = getCallerSlug(c)
  const { slug: targetSlug, sessionId, sync } = c.req.valid('json')

  const target = await getAgent(targetSlug)
  if (!target) return c.json({ error: 'Target agent not found' }, 404)

  if (!(await callerOwnerHasRoleOnTarget(callerSlug, targetSlug, 'viewer'))) {
    return c.json({ error: 'Forbidden: caller has no access to target agent' }, 403)
  }

  const policy = await checkAgentPolicy(callerSlug, 'read', targetSlug, target.frontmatter.name)
  if (!policy.allowed) {
    return c.json({ error: policy.reason ?? 'Forbidden' }, 403)
  }

  if (sync && messagePersister.isSessionActive(sessionId)) {
    try {
      await messagePersister.waitForIdle(sessionId)
    } catch (error) {
      return c.json({
        error: `Session did not idle: ${error instanceof Error ? error.message : String(error)}`,
      }, 504)
    }
  }

  const isAwaiting = messagePersister.isSessionAwaitingInput(sessionId)
  const isActive = messagePersister.isSessionActive(sessionId)
  const status: 'running' | 'idle' | 'awaiting_input' = isAwaiting
    ? 'awaiting_input'
    : isActive
      ? 'running'
      : 'idle'

  const entries = await getSessionMessagesWithCompact(targetSlug, sessionId)
  const messages = entries
    .map(compactMessage)
    .filter((m): m is NonNullable<ReturnType<typeof compactMessage>> => m !== null)

  return c.json({ status, messages })
})

// ----------------------------------------------------------------------------
// POST /api/x-agent/invoke - send prompt to a target agent (new or existing session)
// ----------------------------------------------------------------------------

const invokeBodySchema = z.object({
  slug: z.string(),
  prompt: z.string().min(1),
  sessionId: z.string().optional(),
  sync: z.boolean().optional(),
  // Cycle protection: container sends the calling Claude session ID so the host
  // can reject calls from sessions that were themselves invoked by another agent
  // (one-hop rule — also blocks A→B→A and any deeper chain transitively).
  _callerSessionId: z.string().optional(),
})

xAgent.post('/invoke', zValidator('json', invokeBodySchema), async (c) => {
  const callerSlug = getCallerSlug(c)
  const { slug: targetSlug, prompt, sessionId: existingSessionId, sync, _callerSessionId } = c.req.valid('json')

  if (targetSlug === callerSlug) {
    return c.json({ error: 'Agent cannot invoke itself' }, 400)
  }

  // One-hop rule: a session that was started by another agent cannot itself
  // start invocations into other agents. Prevents A→B→C chains and A→B→A
  // cycles transitively.
  if (_callerSessionId) {
    const callerMeta = await getSessionMetadata(callerSlug, _callerSessionId)
    if (callerMeta?.invokedByAgentSlug) {
      return c.json(
        {
          error:
            `This session was invoked by agent "${callerMeta.invokedByAgentSlug}" and cannot invoke other agents. ` +
            'Cross-agent invocation is one hop deep.',
        },
        403,
      )
    }
  }

  const target = await getAgent(targetSlug)
  if (!target) return c.json({ error: 'Target agent not found' }, 404)

  if (!(await callerOwnerHasRoleOnTarget(callerSlug, targetSlug, 'user'))) {
    return c.json({ error: 'Forbidden: caller has no user access to target agent' }, 403)
  }

  const policy = await checkAgentPolicy(
    callerSlug,
    'invoke',
    targetSlug,
    target.frontmatter.name,
    prompt.slice(0, 200),
  )
  if (!policy.allowed) {
    return c.json({ error: policy.reason ?? 'Forbidden' }, 403)
  }

  // Existing session: must exist, must not be running
  if (existingSessionId) {
    if (messagePersister.isSessionActive(existingSessionId)) {
      return c.json({ error: 'Target session is currently running' }, 409)
    }
    const client = await containerManager.ensureRunning(targetSlug)
    if (!messagePersister.isSubscribed(existingSessionId)) {
      await messagePersister.subscribeToSession(existingSessionId, client, existingSessionId, targetSlug)
    }
    messagePersister.markSessionActive(existingSessionId, targetSlug)
    await client.sendMessage(existingSessionId, prompt)

    if (sync) {
      try {
        await messagePersister.waitForIdle(existingSessionId)
      } catch (error) {
        return c.json({
          sessionId: existingSessionId,
          status: 'running',
          error: error instanceof Error ? error.message : String(error),
        })
      }
      const lastMessage = await readLastAssistantMessage(targetSlug, existingSessionId)
      return c.json({
        sessionId: existingSessionId,
        status: 'completed',
        lastMessage: lastMessage?.content,
      })
    }
    return c.json({ sessionId: existingSessionId, status: 'running' })
  }

  // New session
  const client = await containerManager.ensureRunning(targetSlug)
  const availableEnvVars = await getSecretEnvVars(targetSlug)
  const agentLimits = getEffectiveAgentLimits()
  const customEnvVars = getCustomEnvVars()

  const containerSession = await client.createSession({
    availableEnvVars: availableEnvVars.length > 0 ? availableEnvVars : undefined,
    initialMessage: prompt,
    model: getEffectiveModels().agentModel,
    browserModel: getEffectiveModels().browserModel,
    maxOutputTokens: agentLimits.maxOutputTokens,
    maxThinkingTokens: agentLimits.maxThinkingTokens,
    maxTurns: agentLimits.maxTurns,
    maxBudgetUsd: agentLimits.maxBudgetUsd,
    customEnvVars: Object.keys(customEnvVars).length > 0 ? customEnvVars : undefined,
    maxBrowserTabs: getSettings().app?.maxBrowserTabs,
  })
  const newSessionId = containerSession.id
  // Mark active synchronously before any await so waitForIdle has state to observe
  // even if the SDK's 'result' event lands before subscribeToSession completes.
  messagePersister.markSessionActive(newSessionId, targetSlug)

  // Register on the host. If this fails, the container is already holding a
  // running session — clean it up so we don't leave orphans burning model budget.
  try {
    await registerSession(targetSlug, newSessionId, `Invoked by ${callerSlug}`)
  } catch (registerErr) {
    console.error('[x-agent] registerSession failed; cleaning up container session', registerErr)
    await client.deleteSession(newSessionId).catch((cleanupErr) => {
      // Container was unreachable or session already gone — nothing more we can do
      console.error('[x-agent] failed to clean up orphaned container session', newSessionId, cleanupErr)
    })
    messagePersister.unsubscribeFromSession(newSessionId)
    return c.json(
      { error: `Failed to register invoked session: ${registerErr instanceof Error ? registerErr.message : String(registerErr)}` },
      500,
    )
  }

  // Metadata write failure shouldn't fail the invoke (the session is still
  // usable), but don't silently swallow — log so we can debug missing
  // cross-agent provenance later.
  try {
    await updateSessionMetadata(targetSlug, newSessionId, { invokedByAgentSlug: callerSlug })
  } catch (metaErr) {
    console.warn('[x-agent] updateSessionMetadata failed (session usable, provenance not recorded)', metaErr)
  }

  await messagePersister.subscribeToSession(newSessionId, client, newSessionId, targetSlug)
  if (containerSession.slashCommands && containerSession.slashCommands.length > 0) {
    messagePersister.setSlashCommands(newSessionId, containerSession.slashCommands)
  }

  if (sync) {
    try {
      await messagePersister.waitForIdle(newSessionId)
    } catch (error) {
      return c.json({
        sessionId: newSessionId,
        status: 'running',
        error: error instanceof Error ? error.message : String(error),
      })
    }
    const lastMessage = await readLastAssistantMessage(targetSlug, newSessionId)
    return c.json({
      sessionId: newSessionId,
      status: 'completed',
      lastMessage: lastMessage?.content,
    })
  }
  return c.json({ sessionId: newSessionId, status: 'running' })
})

export default xAgent
