/**
 * Chat Integration Service — CRUD operations for the chat_integrations table.
 */

import { eq, and, inArray, count, ne, notExists, sql, type SQL } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { changesOf, insertWhere } from '@shared/lib/db/batch'
import { chatIntegrations, chatIntegrationSessions } from '@shared/lib/db/schema'
import type { ChatIntegration, NewChatIntegration } from '@shared/lib/db/schema'
import type { ChatProvider } from '@shared/lib/chat-integrations/config-schema'
import { mergeChatIntegrationConfig } from '@shared/lib/chat-integrations/config-schema'
import { captureException } from '@shared/lib/error-reporting'

export type { ChatIntegration, NewChatIntegration }

export class DuplicateBotTokenError extends Error {
  readonly existingIntegrationId: string
  constructor(existingIntegrationId: string, provider?: string) {
    const label = provider === 'imessage' ? 'Phone number' : 'Bot token'
    super(`${label} is already registered on integration ${existingIntegrationId}`)
    this.name = 'DuplicateBotTokenError'
    this.existingIntegrationId = existingIntegrationId
  }
}

// ── Types ───────────────────────────────────────────────────────────────

export interface CreateChatIntegrationParams {
  agentSlug: string
  provider: ChatProvider
  name?: string
  config: Record<string, unknown>
  showToolCalls?: boolean
  sessionTimeout?: number | null
  model?: string | null
  effort?: string | null
  speed?: string | null
  createdByUserId?: string
}

export interface UpdateChatIntegrationParams {
  name?: string
  config?: Record<string, unknown>
  showToolCalls?: boolean
  requireApproval?: boolean
  sessionTimeout?: number | null
  model?: string | null
  effort?: string | null
  speed?: string | null
  status?: 'active' | 'paused' | 'error' | 'disconnected'
  errorMessage?: string | null
}

// ── Create ──────────────────────────────────────────────────────────────

const MAX_UNIQUE_KEY_ATTEMPTS = 3

export async function createChatIntegration(params: CreateChatIntegrationParams): Promise<string> {
  const newToken = extractUniqueKey(params.provider, params.config)
  const id = crypto.randomUUID()
  const now = new Date()

  const newRecord: NewChatIntegration = {
    id,
    agentSlug: params.agentSlug,
    provider: params.provider,
    name: params.name ?? null,
    config: JSON.stringify(params.config),
    showToolCalls: params.showToolCalls ?? false,
    // Always private at create; making a bot public is owner-only via the
    // dedicated PATCH /:integrationId/require-approval endpoint.
    requireApproval: true,
    sessionTimeout: params.sessionTimeout ?? null,
    model: params.model ?? null,
    effort: params.effort ?? null,
    speed: params.speed ?? null,
    createdByUserId: params.createdByUserId ?? null,
    createdAt: now,
    updatedAt: now,
  }

  if (!newToken) {
    await db.insert(chatIntegrations).values(newRecord).run()
    return id
  }

  // The uniqueness check is a condition on the insert itself, so two
  // registrations racing with the same credential admit exactly one. Zero
  // changes means the key is taken; the owner is looked up for the message.
  for (let attempt = 0; attempt < MAX_UNIQUE_KEY_ATTEMPTS; attempt++) {
    const inserted = await insertWhere(chatIntegrations, newRecord, noOtherIntegrationWith(params.provider, newToken)).run()
    if (changesOf(inserted) > 0) return id
    const duplicate = await findIntegrationByUniqueKey(params.provider, newToken)
    if (duplicate) throw new DuplicateBotTokenError(duplicate.id, params.provider)
    // The owner was deleted between the insert and the lookup: try again.
  }
  throw new Error('Chat integration changed concurrently; try again')
}

/**
 * `NOT EXISTS` over the other integrations of `provider` whose config carries
 * `key` in the unique-key field, evaluated by the driver inside the write that
 * uses it. Rows whose config is not valid JSON are skipped, as
 * findIntegrationByUniqueKey() skips them.
 */
function noOtherIntegrationWith(provider: string, key: string, excludeId?: string): SQL {
  const field = provider === 'imessage' ? '$.phoneNumber' : '$.botToken'
  const storedKey = sql`CASE WHEN json_valid(${chatIntegrations.config}) THEN json_extract(${chatIntegrations.config}, ${field}) END`
  return notExists(
    db.select({ one: sql`1` }).from(chatIntegrations).where(and(
      eq(chatIntegrations.provider, provider as ChatIntegration['provider']),
      sql`${storedKey} = ${key}`,
      excludeId ? ne(chatIntegrations.id, excludeId) : undefined,
    )),
  )
}

/** Extract the unique key for duplicate detection: botToken for Telegram/Slack, phoneNumber for iMessage. */
function extractUniqueKey(provider: string, config: Record<string, unknown>): string | null {
  if (provider === 'imessage') {
    const phone = (config as { phoneNumber?: unknown }).phoneNumber
    return typeof phone === 'string' && phone.length > 0 ? phone : null
  }
  const token = (config as { botToken?: unknown }).botToken
  if (provider !== 'telegram' && provider !== 'slack') return null
  return typeof token === 'string' && token.length > 0 ? token : null
}

async function findIntegrationByUniqueKey(
  provider: string,
  key: string,
  excludeId?: string,
): Promise<ChatIntegration | null> {
  const rows = await db.select().from(chatIntegrations)
    .where(eq(chatIntegrations.provider, provider as ChatIntegration['provider']))
    .all()
  const field = provider === 'imessage' ? 'phoneNumber' : 'botToken'
  for (const row of rows) {
    if (excludeId && row.id === excludeId) continue
    const cfg = safeParseConfig(row)
    if (cfg && typeof (cfg as any)[field] === 'string' && (cfg as any)[field] === key) {
      return row
    }
  }
  return null
}

function safeParseConfig(row: ChatIntegration): Record<string, unknown> | null {
  try {
    return JSON.parse(row.config) as Record<string, unknown>
  } catch (err) {
    captureException(err, {
      tags: { component: 'chat-integration', operation: 'parse-config' },
      extra: { integrationId: row.id, provider: row.provider },
    })
    return null
  }
}

// ── Read ────────────────────────────────────────────────────────────────

export async function getChatIntegration(id: string): Promise<ChatIntegration | null> {
  const results = await db.select().from(chatIntegrations).where(eq(chatIntegrations.id, id)).all()
  return results[0] || null
}

export async function listChatIntegrations(agentSlug?: string, status?: string): Promise<ChatIntegration[]> {
  const conditions = []
  if (agentSlug) conditions.push(eq(chatIntegrations.agentSlug, agentSlug))
  if (status) conditions.push(eq(chatIntegrations.status, status as ChatIntegration['status']))

  if (conditions.length === 0) {
    return db.select().from(chatIntegrations).all()
  }
  return db.select().from(chatIntegrations).where(and(...conditions)).all()
}

/**
 * Returns integrations that should be connected on startup (active + error for retry).
 *
 * Deduplicates by unique key (bot token for Telegram/Slack, phone number for
 * iMessage) so we never start two connections against the same credential.
 * When duplicates exist, prefer `active` over `error`; within the same status,
 * prefer the most recently updated row.
 */
export async function listStartupChatIntegrations(): Promise<ChatIntegration[]> {
  const rows = await db.select().from(chatIntegrations)
    .where(inArray(chatIntegrations.status, ['active', 'error']))
    .all()

  const byKey = new Map<string, ChatIntegration>()
  const keyless: ChatIntegration[] = []

  for (const row of rows) {
    const cfg = safeParseConfig(row)
    const uniqueKey = cfg ? extractUniqueKey(row.provider, cfg) : null
    if (!uniqueKey) {
      keyless.push(row)
      continue
    }
    const mapKey = `${row.provider}:${uniqueKey}`
    const existing = byKey.get(mapKey)
    if (!existing || isBetterStartupCandidate(row, existing)) {
      byKey.set(mapKey, row)
    }
  }

  if (rows.length !== byKey.size + keyless.length) {
    captureException(new Error('Duplicate chat integrations detected at startup'), {
      tags: { component: 'chat-integration', operation: 'list-startup' },
      level: 'warning',
      extra: { totalRows: rows.length, uniqueKeys: byKey.size, keyless: keyless.length },
    })
  }

  return [...byKey.values(), ...keyless]
}

function isBetterStartupCandidate(candidate: ChatIntegration, current: ChatIntegration): boolean {
  if (candidate.status === 'active' && current.status !== 'active') return true
  if (candidate.status !== 'active' && current.status === 'active') return false
  const candidateTs = candidate.updatedAt?.getTime?.() ?? 0
  const currentTs = current.updatedAt?.getTime?.() ?? 0
  return candidateTs > currentTs
}

/**
 * Count chat sessions per integration across a set of agents — the
 * "has this connection actually been used" signal for the home graph.
 */
export async function countSessionsPerIntegration(agentSlugs: string[]): Promise<Record<string, number>> {
  if (agentSlugs.length === 0) return {}

  const rows = await db
    .select({ integrationId: chatIntegrationSessions.integrationId, sessions: count() })
    .from(chatIntegrationSessions)
    .innerJoin(chatIntegrations, eq(chatIntegrationSessions.integrationId, chatIntegrations.id))
    .where(inArray(chatIntegrations.agentSlug, agentSlugs))
    .groupBy(chatIntegrationSessions.integrationId)
    .all()

  const counts: Record<string, number> = {}
  for (const row of rows) counts[row.integrationId] = row.sessions
  return counts
}

export async function listChatIntegrationsByAgents(
  agentSlugs: string[],
  // Default stays active-only (the agent-list enrichment tags live chats);
  // the home graph passes allStatuses so error/paused nodes still render.
  options?: { allStatuses?: boolean },
): Promise<Map<string, ChatIntegration[]>> {
  if (agentSlugs.length === 0) return new Map()

  const results = await db.select().from(chatIntegrations)
    .where(and(
      inArray(chatIntegrations.agentSlug, agentSlugs),
      options?.allStatuses ? undefined : eq(chatIntegrations.status, 'active'),
    ))
    .all()

  const map = new Map<string, ChatIntegration[]>()
  for (const row of results) {
    const existing = map.get(row.agentSlug) || []
    existing.push(row)
    map.set(row.agentSlug, existing)
  }
  return map
}

// ── Update ──────────────────────────────────────────────────────────────

export async function updateChatIntegration(id: string, params: UpdateChatIntegrationParams): Promise<boolean> {
  if (params.config === undefined) {
    const result = await db.update(chatIntegrations)
      .set(fieldUpdates(params))
      .where(eq(chatIntegrations.id, id))
      .run()
    return changesOf(result) > 0
  }

  // A config PATCH merges into the stored config, so it is a read then a
  // write. The write replaces the config only if it is still the one that
  // was read; otherwise the merge is redone on the fresh row, so a delayed
  // edit cannot put back a credential the row has since moved away from.
  // When the merge moves the credential, the write is also conditional on no
  // other integration owning the new one (SUP-150's duplicate pollers). A
  // settings-only edit keeps whatever credential the row has, legacy
  // duplicates included.
  for (let attempt = 0; attempt < MAX_UNIQUE_KEY_ATTEMPTS; attempt++) {
    const current = await getChatIntegration(id)
    if (!current) return false

    const nextConfig = mergeChatIntegrationConfig(current.provider, current.config, params.config)
    const currentConfig = safeParseConfig(current)
    const currentToken = currentConfig
      ? extractUniqueKey(current.provider, currentConfig)
      : null
    const newToken = extractUniqueKey(current.provider, nextConfig)
    const movedTo = newToken && newToken !== currentToken ? newToken : null

    const result = await db.update(chatIntegrations)
      .set({ ...fieldUpdates(params), config: JSON.stringify(nextConfig) })
      .where(and(
        eq(chatIntegrations.id, id),
        eq(chatIntegrations.config, current.config),
        movedTo ? noOtherIntegrationWith(current.provider, movedTo, id) : undefined,
      ))
      .run()
    if (changesOf(result) > 0) return true

    // Nothing changed: the row is gone, its config moved on, or another
    // integration owns the new credential. Tell them apart.
    const latest = await getChatIntegration(id)
    if (!latest) return false
    if (latest.config !== current.config || !movedTo) continue
    const duplicate = await findIntegrationByUniqueKey(current.provider, movedTo, id)
    if (duplicate) throw new DuplicateBotTokenError(duplicate.id, current.provider)
  }
  throw new Error('Chat integration changed concurrently; try again')
}

/** The column updates a PATCH carries, config aside. */
function fieldUpdates(params: UpdateChatIntegrationParams): Record<string, unknown> {
  const updates: Record<string, unknown> = { updatedAt: new Date() }
  if (params.name !== undefined) updates.name = params.name
  if (params.showToolCalls !== undefined) updates.showToolCalls = params.showToolCalls
  if (params.requireApproval !== undefined) updates.requireApproval = params.requireApproval
  if (params.sessionTimeout !== undefined) updates.sessionTimeout = params.sessionTimeout
  if (params.model !== undefined) updates.model = params.model
  if (params.effort !== undefined) updates.effort = params.effort
  if (params.speed !== undefined) updates.speed = params.speed
  if (params.status !== undefined) updates.status = params.status
  if (params.errorMessage !== undefined) updates.errorMessage = params.errorMessage
  return updates
}

export async function updateChatIntegrationStatus(
  id: string,
  status: ChatIntegration['status'],
  errorMessage?: string | null,
): Promise<boolean> {
  return updateChatIntegration(id, { status, errorMessage: errorMessage ?? null })
}

// ── Delete ──────────────────────────────────────────────────────────────

export async function deleteChatIntegration(id: string): Promise<boolean> {
  const result = await db.delete(chatIntegrations)
    .where(eq(chatIntegrations.id, id))
    .run()

  return changesOf(result) > 0
}
