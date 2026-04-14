/**
 * Chat Integration Service — CRUD operations for the chat_integrations table.
 */

import { eq, and, inArray } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { chatIntegrations } from '@shared/lib/db/schema'
import type { ChatIntegration, NewChatIntegration } from '@shared/lib/db/schema'

export type { ChatIntegration, NewChatIntegration }

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

/** Returns integrations that should be connected on startup (active + error for retry). */
export function listStartupChatIntegrations(): ChatIntegration[] {
  return db.select().from(chatIntegrations)
    .where(inArray(chatIntegrations.status, ['active', 'error']))
    .all()
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
