import { eq, and, inArray, count, notExists, sql } from 'drizzle-orm'
import crypto from 'node:crypto'
import { db } from '@shared/lib/db'
import { changesOf, insertWhere } from '@shared/lib/db/batch'
import { chatIntegrationAccess, chatIntegrations } from '@shared/lib/db/schema'
import type { ChatIntegrationAccess } from '@shared/lib/db/schema'

export type ChatAccessStatus = 'pending' | 'allowed' | 'denied'
export type AccessDecision = { action: 'forward' | 'blocked'; sendNotice: boolean; status: ChatAccessStatus | 'bootstrapped' }
const PREVIEW_MAX = 200
const NONALLOWED_CAP = 100

export function getChatAccess(integrationId: string, externalChatId: string): ChatIntegrationAccess | null {
  return db.select().from(chatIntegrationAccess)
    .where(and(eq(chatIntegrationAccess.integrationId, integrationId), eq(chatIntegrationAccess.externalChatId, externalChatId)))
    .all()[0] || null
}
export function getChatAccessById(id: string): ChatIntegrationAccess | null {
  return db.select().from(chatIntegrationAccess).where(eq(chatIntegrationAccess.id, id)).all()[0] || null
}
export function listChatAccess(integrationId: string, status?: ChatAccessStatus): ChatIntegrationAccess[] {
  const rows = db.select().from(chatIntegrationAccess).where(eq(chatIntegrationAccess.integrationId, integrationId)).all()
  return status ? rows.filter((r) => r.status === status) : rows
}

function getIntegration(integrationId: string) {
  return db.select().from(chatIntegrations).where(eq(chatIntegrations.id, integrationId)).all()[0] || null
}

// fail-closed for unknown integration; true for non-telegram / public bot
export function isChatAllowed(integrationId: string, externalChatId: string): boolean {
  const integ = getIntegration(integrationId)
  if (!integ) return false
  if (integ.provider !== 'telegram' || integ.requireApproval !== true) return true
  return getChatAccess(integrationId, externalChatId)?.status === 'allowed'
}

export function decideInboundAccess(args: {
  integrationId: string; externalChatId: string
  chatType?: 'private' | 'group' | 'supergroup'
  userId?: string; userName?: string; chatName?: string; preview?: string
}): AccessDecision {
  const integ = getIntegration(args.integrationId)
  if (!integ) return { action: 'blocked', sendNotice: false, status: 'denied' } // fail closed
  if (integ.provider !== 'telegram' || integ.requireApproval !== true) return { action: 'forward', sendNotice: false, status: 'allowed' }

  const existing = getChatAccess(args.integrationId, args.externalChatId)
  if (existing?.status === 'allowed') return { action: 'forward', sendNotice: false, status: 'allowed' }
  if (existing?.status === 'denied') return { action: 'blocked', sendNotice: false, status: 'denied' }
  if (existing?.status === 'pending') {
    refreshPending(existing, args)
    return { action: 'blocked', sendNotice: existing.requestNoticeSentAt == null, status: 'pending' }
  }

  // no row yet — try atomic bootstrap (private only): one INSERT … SELECT … WHERE,
  // so two first messages racing cannot both become the allowed chat
  if (args.chatType === 'private') {
    const now = new Date()
    const noAllowedChatYet = notExists(
      db.select({ one: sql`1` }).from(chatIntegrationAccess)
        .where(and(eq(chatIntegrationAccess.integrationId, args.integrationId), eq(chatIntegrationAccess.status, 'allowed'))),
    )
    const bootstrapped = insertWhere(chatIntegrationAccess, {
      id: crypto.randomUUID(), integrationId: args.integrationId, externalChatId: args.externalChatId,
      chatType: 'private', status: 'allowed', approvalSource: 'auto_first_contact',
      title: args.chatName ?? null, firstUserId: args.userId ?? null, firstUserName: args.userName ?? null,
      firstMessagePreview: preview(args.preview), requestedAt: now, createdAt: now, updatedAt: now,
    }, noAllowedChatYet).run()
    if (changesOf(bootstrapped) === 1) return { action: 'forward', sendNotice: false, status: 'bootstrapped' }
  }

  // not bootstrapped → record pending unless capped
  const nonAllowed = db.select({ value: count() }).from(chatIntegrationAccess)
    .where(and(eq(chatIntegrationAccess.integrationId, args.integrationId), inArray(chatIntegrationAccess.status, ['pending', 'denied']))).get()?.value ?? 0
  if (nonAllowed >= NONALLOWED_CAP) return { action: 'blocked', sendNotice: false, status: 'pending' }

  const now = new Date()
  const ins = db.insert(chatIntegrationAccess).values({
    id: crypto.randomUUID(), integrationId: args.integrationId, externalChatId: args.externalChatId,
    chatType: (args.chatType ?? null) as never, status: 'pending', approvalSource: null,
    title: args.chatName ?? null, firstUserId: args.userId ?? null, firstUserName: args.userName ?? null,
    firstMessagePreview: preview(args.preview), requestedAt: now, createdAt: now, updatedAt: now,
  }).onConflictDoNothing().run()
  return { action: 'blocked', sendNotice: changesOf(ins) === 1, status: 'pending' }
}

function preview(s?: string): string | null { return s ? s.slice(0, PREVIEW_MAX) : null }

function refreshPending(existing: ChatIntegrationAccess, args: { userName?: string; chatName?: string; preview?: string }) {
  const nextPreview = args.preview ? preview(args.preview) : existing.firstMessagePreview
  if (existing.firstUserName === (args.userName ?? existing.firstUserName)
    && existing.title === (args.chatName ?? existing.title)
    && existing.firstMessagePreview === nextPreview) return // skip no-op write
  db.update(chatIntegrationAccess).set({
    firstUserName: args.userName ?? existing.firstUserName, title: args.chatName ?? existing.title,
    firstMessagePreview: nextPreview, updatedAt: new Date(),
  }).where(eq(chatIntegrationAccess.id, existing.id)).run()
}

export function markNoticeSent(id: string): void {
  db.update(chatIntegrationAccess).set({ requestNoticeSentAt: new Date(), updatedAt: new Date() })
    .where(eq(chatIntegrationAccess.id, id)).run()
}

// state-guarded transitions — return true only when a valid transition occurred
export function approveChatAccess(id: string, by: string): boolean {
  return changesOf(db.update(chatIntegrationAccess)
    .set({ status: 'allowed', approvalSource: 'owner', decidedByUserId: by, decidedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(chatIntegrationAccess.id, id), inArray(chatIntegrationAccess.status, ['pending', 'denied']))).run()) > 0
}
export function denyChatAccess(id: string, by: string): boolean {
  return changesOf(db.update(chatIntegrationAccess)
    .set({ status: 'denied', decidedByUserId: by, decidedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(chatIntegrationAccess.id, id), inArray(chatIntegrationAccess.status, ['pending', 'allowed']))).run()) > 0
}
export function revokeChatAccess(id: string, by: string): boolean {
  return changesOf(db.update(chatIntegrationAccess)
    .set({ status: 'denied', decidedByUserId: by, decidedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(chatIntegrationAccess.id, id), eq(chatIntegrationAccess.status, 'allowed'))).run()) > 0
}
