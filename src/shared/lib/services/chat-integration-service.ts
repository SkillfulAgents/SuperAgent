/**
 * Chat Integration Service — CRUD operations for the chat_integrations table.
 */

import { eq, and, inArray } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { chatIntegrations } from '@shared/lib/db/schema'
import type { ChatIntegration, NewChatIntegration } from '@shared/lib/db/schema'
import { captureException } from '@shared/lib/error-reporting'

export type { ChatIntegration, NewChatIntegration }

export class DuplicateBotTokenError extends Error {
  readonly existingIntegrationId: string
  constructor(existingIntegrationId: string) {
    super(`Bot token is already registered on integration ${existingIntegrationId}`)
    this.name = 'DuplicateBotTokenError'
    this.existingIntegrationId = existingIntegrationId
  }
}

// ── Types ───────────────────────────────────────────────────────────────

export interface CreateChatIntegrationParams {
  agentSlug: string
  provider: 'telegram' | 'slack'
  name?: string
  config: Record<string, unknown>
  showToolCalls?: boolean
  createdByUserId?: string
}

export interface UpdateChatIntegrationParams {
  name?: string
  config?: Record<string, unknown>
  showToolCalls?: boolean
  status?: 'active' | 'paused' | 'error' | 'disconnected'
  errorMessage?: string | null

}

// ── Create ──────────────────────────────────────────────────────────────

export function createChatIntegration(params: CreateChatIntegrationParams): string {
  const newToken = extractBotToken(params.provider, params.config)
  if (newToken) {
    const duplicate = findIntegrationByBotToken(params.provider, newToken)
    if (duplicate) {
      throw new DuplicateBotTokenError(duplicate.id)
    }
  }

  const id = crypto.randomUUID()
  const now = new Date()

  const newRecord: NewChatIntegration = {
    id,
    agentSlug: params.agentSlug,
    provider: params.provider,
    name: params.name ?? null,
    config: JSON.stringify(params.config),
    showToolCalls: params.showToolCalls ?? false,
    createdByUserId: params.createdByUserId ?? null,
    createdAt: now,
    updatedAt: now,
  }

  db.insert(chatIntegrations).values(newRecord).run()
  return id
}

function extractBotToken(provider: string, config: Record<string, unknown>): string | null {
  const token = (config as { botToken?: unknown }).botToken
  if (provider !== 'telegram' && provider !== 'slack') return null
  return typeof token === 'string' && token.length > 0 ? token : null
}

function findIntegrationByBotToken(
  provider: string,
  token: string,
  excludeId?: string,
): ChatIntegration | null {
  const rows = db.select().from(chatIntegrations)
    .where(eq(chatIntegrations.provider, provider as ChatIntegration['provider']))
    .all()
  for (const row of rows) {
    if (excludeId && row.id === excludeId) continue
    const cfg = safeParseConfig(row)
    if (cfg && typeof cfg.botToken === 'string' && cfg.botToken === token) {
      return row
    }
  }
  return null
}

function safeParseConfig(row: ChatIntegration): { botToken?: string } | null {
  try {
    return JSON.parse(row.config) as { botToken?: string }
  } catch (err) {
    captureException(err, {
      tags: { component: 'chat-integration', operation: 'parse-config' },
      extra: { integrationId: row.id, provider: row.provider },
    })
    return null
  }
}

// ── Read ────────────────────────────────────────────────────────────────

export function getChatIntegration(id: string): ChatIntegration | null {
  const results = db.select().from(chatIntegrations).where(eq(chatIntegrations.id, id)).all()
  return results[0] || null
}

export function listChatIntegrations(agentSlug?: string, status?: string): ChatIntegration[] {
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
 * Deduplicates by bot token so we never start two pollers against the same
 * Telegram token — that triggers a 409 Conflict from `getUpdates` and, if
 * unhandled, crashes the Electron app (see SUP-150).
 * When duplicates exist, prefer `active` over `error`; within the same status,
 * prefer the most recently updated row.
 */
export function listStartupChatIntegrations(): ChatIntegration[] {
  const rows = db.select().from(chatIntegrations)
    .where(inArray(chatIntegrations.status, ['active', 'error']))
    .all()

  const byToken = new Map<string, ChatIntegration>()
  const tokenless: ChatIntegration[] = []

  for (const row of rows) {
    const cfg = safeParseConfig(row)
    const token = cfg && typeof cfg.botToken === 'string' ? cfg.botToken : null
    if (!token) {
      tokenless.push(row)
      continue
    }
    const key = `${row.provider}:${token}`
    const existing = byToken.get(key)
    if (!existing || isBetterStartupCandidate(row, existing)) {
      byToken.set(key, row)
    }
  }

  if (rows.length !== byToken.size + tokenless.length) {
    captureException(new Error('Duplicate chat integrations detected at startup'), {
      tags: { component: 'chat-integration', operation: 'list-startup' },
      level: 'warning',
      extra: { totalRows: rows.length, uniqueTokens: byToken.size, tokenless: tokenless.length },
    })
  }

  return [...byToken.values(), ...tokenless]
}

function isBetterStartupCandidate(candidate: ChatIntegration, current: ChatIntegration): boolean {
  if (candidate.status === 'active' && current.status !== 'active') return true
  if (candidate.status !== 'active' && current.status === 'active') return false
  const candidateTs = candidate.updatedAt?.getTime?.() ?? 0
  const currentTs = current.updatedAt?.getTime?.() ?? 0
  return candidateTs > currentTs
}

export function listChatIntegrationsByAgents(agentSlugs: string[]): Map<string, ChatIntegration[]> {
  if (agentSlugs.length === 0) return new Map()

  const results = db.select().from(chatIntegrations)
    .where(and(
      inArray(chatIntegrations.agentSlug, agentSlugs),
      eq(chatIntegrations.status, 'active'),
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

export function updateChatIntegration(id: string, params: UpdateChatIntegrationParams): boolean {
  // Guard against a PATCH moving a token to one that's already owned by
  // another integration — would re-create SUP-150's duplicate-poller scenario.
  if (params.config !== undefined) {
    const current = getChatIntegration(id)
    if (current) {
      const newToken = extractBotToken(current.provider, params.config)
      if (newToken) {
        const duplicate = findIntegrationByBotToken(current.provider, newToken, id)
        if (duplicate) {
          throw new DuplicateBotTokenError(duplicate.id)
        }
      }
    }
  }

  const updates: Record<string, unknown> = {
    updatedAt: new Date(),
  }

  if (params.name !== undefined) updates.name = params.name
  if (params.config !== undefined) updates.config = JSON.stringify(params.config)
  if (params.showToolCalls !== undefined) updates.showToolCalls = params.showToolCalls
  if (params.status !== undefined) updates.status = params.status
  if (params.errorMessage !== undefined) updates.errorMessage = params.errorMessage


  const result = db.update(chatIntegrations)
    .set(updates)
    .where(eq(chatIntegrations.id, id))
    .run()

  return result.changes > 0
}

export function updateChatIntegrationStatus(
  id: string,
  status: ChatIntegration['status'],
  errorMessage?: string | null,
): boolean {
  return updateChatIntegration(id, { status, errorMessage: errorMessage ?? null })
}

// ── Delete ──────────────────────────────────────────────────────────────

export function deleteChatIntegration(id: string): boolean {
  const result = db.delete(chatIntegrations)
    .where(eq(chatIntegrations.id, id))
    .run()

  return result.changes > 0
}
