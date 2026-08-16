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
import { and, desc, eq } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { agentAcl, messageAuthor } from '@shared/lib/db/schema'
import { isAuthMode } from '@shared/lib/auth/mode'
import { hasMinRole, type AgentRole } from '@shared/lib/types/agent'
import { runWithOptionalUser } from '@shared/lib/platform-attribution'
import { validateProxyToken } from '@shared/lib/proxy/token-store'
import {
  createAgent,
  listAgents,
  getAgent,
} from '@shared/lib/services/agent-service'
import { resolveAgentId, displaySlug } from '@shared/lib/utils/file-storage'
import {
  listSessions,
  getSessionMessagesWithCompact,
  findLastSessionEntry,
  getSessionMetadata,
  registerSession,
  reserveSessionOwnership,
  updateSessionMetadata,
  sessionIsKnown,
} from '@shared/lib/services/session-service'
import { containerManager } from '@shared/lib/container/container-manager'
import { messagePersister } from '@shared/lib/container/message-persister'
import { reviewManager } from '@shared/lib/proxy/review-manager'
import {
  evaluate as evaluatePolicy,
  type XAgentOperation,
} from '@shared/lib/services/x-agent-policy-service'
import { getEffectiveModels, getEffectiveAgentLimits, getCustomEnvVars, getSettings } from '@shared/lib/config/settings'
import { resolveRuntimeInherit } from '@shared/lib/container/runtime-options'
import { getSecretEnvVars } from '@shared/lib/services/secrets-service'
import { readAgentPreferences } from '@shared/lib/services/agent-preferences-service'
import { captureException } from '@shared/lib/error-reporting'
import type { JsonlMessageEntry, JsonlSystemEntry } from '@shared/lib/types/agent'

const X_AGENT_SENTRY = { area: 'x-agent', op: 'invoke' } as const

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
 * Resolve the user who sent the message currently driving an agent session.
 * In shared sessions this can differ from the session creator, so invocation
 * attribution must prefer the latest per-message author record.
 */
async function getLatestMessageAuthorUserId(
  agentSlug: string,
  sessionId: string,
): Promise<string | undefined> {
  try {
    const rows = await db
      .select({ userId: messageAuthor.userId })
      .from(messageAuthor)
      .where(and(
        eq(messageAuthor.agentSlug, agentSlug),
        eq(messageAuthor.sessionId, sessionId),
      ))
      .orderBy(desc(messageAuthor.createdAt), desc(messageAuthor.id))
      .limit(1)
    return rows[0]?.userId
  } catch (error) {
    // Attribution is optional. A DB/read failure must never block the invoke.
    console.warn('[x-agent] failed to resolve triggering message author; continuing unattributed', {
      agentSlug,
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    })
    return undefined
  }
}

async function insertMessageAuthorBestEffort(params: {
  id: string
  sessionId: string
  agentSlug: string
  userId: string
}): Promise<boolean> {
  try {
    await db.insert(messageAuthor).values(params)
    return true
  } catch (error) {
    // Includes stale createdByUserId values whose user row has been deleted.
    // The invocation remains usable; only the optional sender badge is lost.
    console.warn('[x-agent] failed to record invoked message author; continuing unattributed', {
      agentSlug: params.agentSlug,
      sessionId: params.sessionId,
      userId: params.userId,
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}

async function deleteMessageAuthorBestEffort(messageUuid: string): Promise<void> {
  try {
    await db.delete(messageAuthor).where(eq(messageAuthor.id, messageUuid))
  } catch (error) {
    console.warn('[x-agent] failed to clean up invoked message attribution', {
      messageUuid,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

async function getAgentDisplayNameBestEffort(agentSlug: string): Promise<string> {
  try {
    const agent = await getAgent(agentSlug)
    return agent?.frontmatter.name || agentSlug
  } catch (error) {
    // Human-readable naming is cosmetic and must not gate agent invocation.
    console.warn('[x-agent] failed to resolve caller display name; using slug', {
      agentSlug,
      error: error instanceof Error ? error.message : String(error),
    })
    return agentSlug
  }
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
      // Project the decorative display slug for the model; resolveAgentId tolerates
      // it (and the bare id / legacy form) on the way back in via invoke/get-*.
      slug: displaySlug(a.frontmatter.name, a.slug),
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

  // Announce only after ACL inheritance so live stream filters admit owners.
  messagePersister.broadcastGlobal({
    type: 'agent_created',
    agentSlug: agent.slug,
  })

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
  const callerSlug = getCallerSlug(c)
  const { slug: rawTargetSlug, limit = 50, offset = 0 } = c.req.valid('json')

  // Resolve the model-supplied display slug to the canonical id and rebind, so
  // every downstream ACL / policy / fs use below keys on the id, not the prefix.
  const targetSlug = await resolveAgentId(rawTargetSlug)
  if (!targetSlug) return c.json({ error: 'Target agent not found' }, 404)

  const target = await getAgent(targetSlug)
  if (!target) return c.json({ error: 'Target agent not found' }, 404)

  if (!(await callerOwnerHasRoleOnTarget(callerSlug, targetSlug, 'viewer'))) {
    return c.json({ error: 'Forbidden: caller has no access to target agent' }, 403)
  }

  const policy = await checkAgentPolicy(callerSlug, 'read', targetSlug, target.frontmatter.name)
  if (!policy.allowed) {
    return c.json({ error: policy.reason ?? 'Forbidden' }, 403)
  }

  const allSessions = await listSessions(targetSlug)
  const page = allSessions.slice(offset, offset + limit)
  return c.json({
    sessions: page.map((s) => ({
      id: s.id,
      name: s.name,
      createdAt: s.createdAt,
      lastActivityAt: s.lastActivityAt,
      messageCount: s.messageCount,
      isRunning: messagePersister.isSessionActive(s.id),
    })),
    total: allSessions.length,
    offset,
    limit,
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

// Sync x-agent calls hold the HTTP response open with zero bytes written until
// the target turn completes, and the container's fetch (undici) aborts any
// request whose response headers don't arrive within 300s ("fetch failed").
// Cap the sync wait well under that cliff: sync is meant for fast turns, so a
// slow turn promotes to the async contract (status 'running' + session id)
// instead of dying as a network error that invites the caller to retry.
//
// The budget is end-to-end from handler entry, not from when waitForIdle
// starts: policy review and container startup happen first and can be slow,
// and a wait that ignored them could still push the total response time past
// the transport cliff.
const SYNC_WAIT_TIMEOUT_DEFAULT_MS = 120_000

// Exported for unit tests. The env override can only SHORTEN the wait (its
// purpose is keeping tests snappy): the container tool docs promise "up to
// ~2 minutes", and a longer wait would both break that promise and erode the
// margin to the 300s transport cliff.
export function resolveSyncWaitTimeoutMs(raw: string | undefined): number {
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return SYNC_WAIT_TIMEOUT_DEFAULT_MS
  return Math.min(parsed, SYNC_WAIT_TIMEOUT_DEFAULT_MS)
}

const SYNC_WAIT_TIMEOUT_MS = resolveSyncWaitTimeoutMs(process.env.X_AGENT_SYNC_WAIT_TIMEOUT_MS)

// Hard stop for delivering the prompt at all. Past this point the caller's
// fetch has been dead-or-dying for a while (undici gives up at 300s), so
// delivering anyway creates exactly the ghost run the caller's inevitable
// retry then duplicates. Applies to async invokes too — they also respond
// only after delivery, so a slow container start can strand them the same way.
// The 60s margin leaves room for the delivery call itself plus the response.
const DELIVERY_CUTOFF_MS = 240_000

function deliveryCutoffError(): string {
  return (
    `Target agent took too long to become ready (over ${Math.round(DELIVERY_CUTOFF_MS / 1000)}s), ` +
    'so the prompt was NOT delivered. It is safe to retry; prefer sync=false.'
  )
}

// Matched by name rather than instanceof: the persister module is wholesale-
// mocked in many test suites, and an instanceof against a possibly-undefined
// mock export throws instead of returning false.
function isWaitForIdleTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === 'WaitForIdleTimeoutError'
}

/**
 * Wait for the target turn to finish within what's left of the caller's sync
 * budget (deadline is stamped at handler entry). Returns 'timeout' when the
 * budget is exhausted — before or during the wait — and rethrows any other
 * waitForIdle failure.
 *
 * requireActiveFirst is off: every sync caller marks the session active before
 * the prompt is delivered (invoke) or checks isSessionActive just before
 * waiting (get-transcript), so an inactive session here means the turn already
 * finished — resolving immediately is correct, not a startup race.
 */
async function waitForTurnWithinBudget(
  sessionId: string,
  deadline: number,
): Promise<'completed' | 'timeout'> {
  const remainingMs = deadline - Date.now()
  if (remainingMs <= 0) {
    // Pre-wait work can eat the whole budget; if the turn already finished
    // during it, that's a completion — reporting 'timeout' here would label a
    // finished turn 'running' and make the caller poll for a result it has.
    return messagePersister.isSessionActive(sessionId) ? 'timeout' : 'completed'
  }
  try {
    await messagePersister.waitForIdle(sessionId, {
      timeoutMs: remainingMs,
      requireActiveFirst: false,
    })
    return 'completed'
  } catch (error) {
    if (isWaitForIdleTimeout(error)) return 'timeout'
    throw error
  }
}

function syncWaitPromotedNote(timeoutMs: number): string {
  return (
    `Sync wait timed out after ${Math.round(timeoutMs / 1000)}s, but the target agent is still ` +
    'working on this prompt. Do NOT re-invoke — that would start a duplicate run. ' +
    'Poll get_agent_session_transcript with this session_id to retrieve the result.'
  )
}

function isReturnableAssistantEntry(e: JsonlMessageEntry | JsonlSystemEntry): boolean {
  return e.type === 'assistant' && compactMessage(e) !== null
}

/**
 * `boundaryUuid` is the uuid of the last assistant entry persisted BEFORE the
 * current turn's prompt was delivered (undefined when the session is new or
 * had none). Seeing that entry still last means this turn's reply hasn't
 * flushed yet — keep polling rather than returning the previous turn's answer
 * as if it were this one's.
 */
async function readLastAssistantMessage(
  targetSlug: string,
  sessionId: string,
  boundaryUuid?: string,
): Promise<{ role: string; content: string; toolName?: string } | null> {
  for (let i = 0; i < READ_RETRY_ATTEMPTS; i++) {
    // Only the most recent assistant entry matters, so read the transcript
    // from the tail instead of full-parsing it (transcripts reach 100MB+, and
    // this runs up to READ_RETRY_ATTEMPTS times per invoke).
    const entry = await findLastSessionEntry(targetSlug, sessionId, isReturnableAssistantEntry)
    const isStaleBoundary = boundaryUuid !== undefined && entry?.uuid === boundaryUuid
    if (entry && !isStaleBoundary) {
      const compact = compactMessage(entry)
      if (compact) return compact
    }
    if (i < READ_RETRY_ATTEMPTS - 1) {
      await new Promise((r) => setTimeout(r, READ_RETRY_INTERVAL_MS))
    }
  }
  return null
}

xAgent.post('/get-transcript', zValidator('json', getTranscriptBodySchema), async (c) => {
  // Stamp the sync budget before any slow pre-work (policy review can block on
  // a human decision) so the total response time stays under the transport cap.
  const syncDeadline = Date.now() + SYNC_WAIT_TIMEOUT_MS
  const callerSlug = getCallerSlug(c)
  const { slug: rawTargetSlug, sessionId, sync } = c.req.valid('json')

  // Resolve the model-supplied display slug to the canonical id and rebind.
  const targetSlug = await resolveAgentId(rawTargetSlug)
  if (!targetSlug) return c.json({ error: 'Target agent not found' }, 404)

  const target = await getAgent(targetSlug)
  if (!target) return c.json({ error: 'Target agent not found' }, 404)

  if (!(await callerOwnerHasRoleOnTarget(callerSlug, targetSlug, 'viewer'))) {
    return c.json({ error: 'Forbidden: caller has no access to target agent' }, 403)
  }

  const policy = await checkAgentPolicy(callerSlug, 'read', targetSlug, target.frontmatter.name)
  if (!policy.allowed) {
    return c.json({ error: policy.reason ?? 'Forbidden' }, 403)
  }

  // Status and wait state live in the process-global persister. Validate the
  // target/session pair before consulting it, not only before reading the
  // target-scoped transcript below.
  if (!(await sessionIsKnown(targetSlug, sessionId))) {
    return c.json({ error: 'Session not found' }, 404)
  }

  if (sync && messagePersister.isSessionActive(sessionId)) {
    // Last reply flushed before we started waiting — used below to detect that
    // the turn we waited out has actually reached the transcript file.
    const boundaryEntry = await findLastSessionEntry(targetSlug, sessionId, isReturnableAssistantEntry)
    try {
      // 'timeout' falls through: return the transcript so far with status
      // 'running'. Sync get-transcript is a bounded long-poll the caller can
      // repeat, not an unbounded wait — an unbounded wait would outlive the
      // container's 300s fetch header timeout and surface as a retry-inducing
      // network error. Other failures stay hard errors.
      const outcome = await waitForTurnWithinBudget(sessionId, syncDeadline)
      if (outcome === 'completed') {
        // The turn's 'result' event clears isActive before its final assistant
        // entry hits the JSONL file. Reconcile (bounded, ~5s) until an entry
        // newer than the pre-wait boundary appears, so an "idle" response
        // doesn't ship a transcript missing the reply it waited for.
        await readLastAssistantMessage(targetSlug, sessionId, boundaryEntry?.uuid)
      }
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
  // Stamp both clocks before any slow pre-work (policy review, container
  // startup, session creation): the sync budget governs how long we wait for
  // the turn, the delivery cutoff governs whether we deliver the prompt at all
  // — so the total response time stays under the container fetch's 300s header
  // timeout, and no prompt is delivered to a caller that already gave up.
  const syncDeadline = Date.now() + SYNC_WAIT_TIMEOUT_MS
  const deliveryCutoff = Date.now() + DELIVERY_CUTOFF_MS
  const callerSlug = getCallerSlug(c)
  const { slug: rawTargetSlug, prompt, sessionId: existingSessionId, sync, _callerSessionId } = c.req.valid('json')

  // Resolve display slug → canonical id so ACL / policy / runtime all use ids.
  const targetSlug = await resolveAgentId(rawTargetSlug)
  if (!targetSlug) return c.json({ error: 'Target agent not found' }, 404)

  if (targetSlug === callerSlug) {
    return c.json({ error: 'Agent cannot invoke itself' }, 400)
  }

  // One-hop rule: sessions started by another agent cannot invoke further.
  const callerMeta = _callerSessionId
    ? await getSessionMetadata(callerSlug, _callerSessionId)
    : null
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

  // Capture the triggering message's author before a review prompt can pause
  // this request and newer messages can arrive in a shared caller session.
  // This remains a best-effort "latest author" heuristic until the container
  // can pass the exact driving message UUID.
  const triggeringUserId = isAuthMode() && _callerSessionId
    ? await getLatestMessageAuthorUserId(callerSlug, _callerSessionId)
    : undefined

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

  // Attribute to the triggering message author. Session creator and caller
  // owner remain compatibility fallbacks for old sessions without author rows.
  let attributedUserId: string | undefined = triggeringUserId ?? callerMeta?.createdByUserId
  if (!attributedUserId && isAuthMode()) {
    try {
      attributedUserId = (await getOwnersOfAgent(callerSlug))[0]
    } catch (error) {
      // ACL checks already ran above; this second lookup is attribution-only.
      console.warn('[x-agent] failed to resolve caller owner for attribution; continuing unattributed', {
        callerSlug,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return runWithOptionalUser(attributedUserId, async () => {
    // Stages for runtime 500s: ensure_running → create_session / send_message.
    let stage = 'ensure_running'
    try {
      if (existingSessionId) {
        // Invoke rights on the target say nothing about the session id sent
        // with them. The persister is keyed by session id alone, so a third
        // agent's id would get re-pointed at the target's container here — and
        // the target's transcript written under it.
        if (!(await sessionIsKnown(targetSlug, existingSessionId))) {
          return c.json({ error: 'Session not found' }, 404)
        }
        if (messagePersister.isSessionActive(existingSessionId)) {
          return c.json({ error: 'Target session is currently running' }, 409)
        }
        stage = 'ensure_running'
        const client = await containerManager.ensureRunning(targetSlug)
        if (Date.now() > deliveryCutoff) {
          console.warn('[x-agent] delivery cutoff exceeded before send; prompt not delivered', {
            callerSlug,
            targetSlug,
            sessionId: existingSessionId,
          })
          return c.json({ error: deliveryCutoffError() }, 504)
        }
        // Last reply flushed before THIS prompt goes out — used to make sure a
        // fast turn's answer isn't confused with the previous turn's while the
        // new entry is still being written to the JSONL file.
        const replyBoundary = sync
          ? await findLastSessionEntry(targetSlug, existingSessionId, isReturnableAssistantEntry)
          : null
        stage = 'subscribe'
        if (!messagePersister.isSubscribed(existingSessionId)) {
          await messagePersister.subscribeToSession(existingSessionId, client, existingSessionId, targetSlug)
        }
        messagePersister.markSessionActive(existingSessionId, targetSlug)
        stage = 'send_message'
        let messageUuid: string | undefined
        if (isAuthMode() && attributedUserId) {
          const candidateUuid = randomUUID()
          const recorded = await insertMessageAuthorBestEffort({
            id: candidateUuid,
            sessionId: existingSessionId,
            agentSlug: targetSlug,
            userId: attributedUserId,
          })
          if (recorded) messageUuid = candidateUuid
        }
        try {
          if (messageUuid) {
            await client.sendMessage(existingSessionId, prompt, messageUuid)
          } else {
            await client.sendMessage(existingSessionId, prompt)
          }
        } catch (sendError) {
          if (messageUuid) await deleteMessageAuthorBestEffort(messageUuid)
          throw sendError
        }

        if (sync) {
          stage = 'wait_for_idle'
          let outcome: 'completed' | 'timeout'
          try {
            outcome = await waitForTurnWithinBudget(existingSessionId, syncDeadline)
          } catch (error) {
            return c.json({
              sessionId: existingSessionId,
              status: 'running',
              error: error instanceof Error ? error.message : String(error),
            })
          }
          if (outcome === 'timeout') {
            // Budget exhausted (whether before or during the wait) means the
            // target is simply still working — promote to the async contract
            // with explicit guidance so the caller polls instead of re-invoking
            // (a re-invoke duplicates the whole run).
            return c.json({
              sessionId: existingSessionId,
              status: 'running',
              error: syncWaitPromotedNote(SYNC_WAIT_TIMEOUT_MS),
            })
          }
          const lastMessage = await readLastAssistantMessage(
            targetSlug,
            existingSessionId,
            replyBoundary?.uuid,
          )
          return c.json({
            sessionId: existingSessionId,
            status: 'completed',
            lastMessage: lastMessage?.content,
          })
        }
        return c.json({ sessionId: existingSessionId, status: 'running' })
      }

      stage = 'ensure_running'
      const client = await containerManager.ensureRunning(targetSlug)
      const availableEnvVars = await getSecretEnvVars(targetSlug)
      const agentLimits = getEffectiveAgentLimits()
      const customEnvVars = getCustomEnvVars()
      const targetPrefs = await readAgentPreferences(targetSlug)
      const models = getEffectiveModels()
      const resolved = resolveRuntimeInherit({}, targetPrefs, models)
      const callerName = await getAgentDisplayNameBestEffort(callerSlug)
      const initialMessageUuid = isAuthMode() && attributedUserId
        ? randomUUID()
        : undefined

      // createSession delivers the prompt (initialMessage) — same cutoff rule
      // as sendMessage above.
      if (Date.now() > deliveryCutoff) {
        console.warn('[x-agent] delivery cutoff exceeded before create; prompt not delivered', {
          callerSlug,
          targetSlug,
        })
        return c.json({ error: deliveryCutoffError() }, 504)
      }
      stage = 'create_session'
      const containerSession = await client.createSession({
        availableEnvVars: availableEnvVars.length > 0 ? availableEnvVars : undefined,
        initialMessage: prompt,
        ...(initialMessageUuid ? { initialMessageUuid } : {}),
        model: resolved.model,
        browserModel: models.browserModel,
        dashboardBuilderModel: models.dashboardBuilderModel,
        effort: resolved.effort,
        speed: resolved.speed,
        maxOutputTokens: agentLimits.maxOutputTokens,
        maxThinkingTokens: agentLimits.maxThinkingTokens,
        maxTurns: agentLimits.maxTurns,
        maxBudgetUsd: agentLimits.maxBudgetUsd,
        customEnvVars: Object.keys(customEnvVars).length > 0 ? customEnvVars : undefined,
        maxBrowserTabs: getSettings().app?.maxBrowserTabs,
      })
      const newSessionId = containerSession.id
      await reserveSessionOwnership(targetSlug, newSessionId)
      // Mark active before any await so waitForIdle sees state if result arrives early.
      messagePersister.markSessionActive(newSessionId, targetSlug)

      const authorRecorded = initialMessageUuid && attributedUserId
        ? await insertMessageAuthorBestEffort({
            id: initialMessageUuid,
            sessionId: newSessionId,
            agentSlug: targetSlug,
            userId: attributedUserId,
          })
        : false

      stage = 'register_session'
      try {
        await registerSession(targetSlug, newSessionId, `Invoked by ${callerName}`)
      } catch (registerErr) {
        const message = registerErr instanceof Error ? registerErr.message : String(registerErr)
        console.error('[x-agent] invoke failed', {
          callerSlug,
          targetSlug,
          sessionId: newSessionId,
          stage,
          error: message,
        })
        captureException(registerErr, {
          tags: { ...X_AGENT_SENTRY, stage },
          extra: { callerSlug, targetSlug, sessionId: newSessionId },
        })
        await client.deleteSession(newSessionId).catch((cleanupErr) => {
          console.error('[x-agent] failed to clean up orphaned container session', {
            sessionId: newSessionId,
            error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
          })
        })
        if (authorRecorded && initialMessageUuid) {
          await deleteMessageAuthorBestEffort(initialMessageUuid)
        }
        messagePersister.unsubscribeFromSession(newSessionId)
        return c.json({ error: `Failed to register invoked session: ${message}` }, 500)
      }

      try {
        await updateSessionMetadata(targetSlug, newSessionId, {
          invokedByAgentSlug: callerSlug,
          ...(authorRecorded && attributedUserId ? { createdByUserId: attributedUserId } : {}),
        })
      } catch (metaErr) {
        console.warn('[x-agent] updateSessionMetadata failed (session usable, provenance not recorded)', {
          callerSlug,
          targetSlug,
          sessionId: newSessionId,
          error: metaErr instanceof Error ? metaErr.message : String(metaErr),
        })
      }

      stage = 'subscribe'
      await messagePersister.subscribeToSession(newSessionId, client, newSessionId, targetSlug)
      if (containerSession.slashCommands && containerSession.slashCommands.length > 0) {
        messagePersister.setSlashCommands(newSessionId, containerSession.slashCommands)
      }

      if (sync) {
        stage = 'wait_for_idle'
        let outcome: 'completed' | 'timeout'
        try {
          outcome = await waitForTurnWithinBudget(newSessionId, syncDeadline)
        } catch (error) {
          return c.json({
            sessionId: newSessionId,
            status: 'running',
            error: error instanceof Error ? error.message : String(error),
          })
        }
        if (outcome === 'timeout') {
          // Budget exhausted (whether before or during the wait) means the
          // target is simply still working — promote to the async contract
          // with explicit guidance so the caller polls instead of re-invoking
          // (a re-invoke duplicates the whole run).
          return c.json({
            sessionId: newSessionId,
            status: 'running',
            error: syncWaitPromotedNote(SYNC_WAIT_TIMEOUT_MS),
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
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[x-agent] invoke failed', {
        callerSlug,
        targetSlug,
        existingSessionId: existingSessionId ?? null,
        stage,
        error: message,
      })
      captureException(err, {
        tags: { ...X_AGENT_SENTRY, stage },
        extra: { callerSlug, targetSlug, existingSessionId: existingSessionId ?? null },
      })
      return c.json({ error: `Failed to invoke agent (${stage}): ${message}` }, 500)
    }
  })
})

export default xAgent
