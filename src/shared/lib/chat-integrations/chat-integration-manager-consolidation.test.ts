import { describe, it, expect, vi } from 'vitest'

// Importing the manager pulls in its dependency graph — stub the heavy modules so
// the import is side-effect free (the selectors + buildChatSystemPrompt are pure).
vi.mock('../db', () => ({ get db() { return undefined }, get sqlite() { return undefined } }))
vi.mock('@shared/lib/services/chat-integration-service', () => ({
  getChatIntegration: vi.fn(),
  listStartupChatIntegrations: vi.fn().mockReturnValue([]),
  updateChatIntegrationStatus: vi.fn(),
}))
vi.mock('@shared/lib/container/container-manager', () => ({ containerManager: { ensureRunning: vi.fn() } }))
vi.mock('@shared/lib/proxy/review-manager', () => ({ reviewManager: { submitDecision: vi.fn() } }))
vi.mock('@shared/lib/error-reporting', () => ({ captureException: vi.fn(), addErrorBreadcrumb: vi.fn() }))

import { buildChatSystemPrompt, selectRotationTargets, selectConsolidationTargets } from './chat-integration-manager'
import type { ChatIntegrationSession } from '../db/schema'

const HOUR = 60 * 60 * 1000
function row(over: Partial<ChatIntegrationSession>): ChatIntegrationSession {
  const now = new Date()
  return {
    id: 'id',
    integrationId: 'int',
    externalChatId: 'chat',
    sessionId: over.id ?? 'sess',
    displayName: null,
    archivedAt: null,
    rotatedAt: null,
    recap: null,
    consolidatedAt: null,
    createdAt: now,
    updatedAt: now,
    ...over,
  } as ChatIntegrationSession
}
const noneActive = () => false
const allowAll = () => true

describe('buildChatSystemPrompt', () => {
  it('combines the iMessage prompt and the recap, dropping neither', () => {
    const out = buildChatSystemPrompt('imessage', 'User prefers terse replies.')
    expect(out).toContain('iMessage-based conversation')
    expect(out).toContain('User prefers terse replies.')
  })

  it('returns just the iMessage prompt when there is no recap', () => {
    const out = buildChatSystemPrompt('imessage', null)
    expect(out).toContain('iMessage-based conversation')
    expect(out).not.toContain('previous conversation')
  })

  it('wraps a non-imessage recap in a labeled "previous conversation" block, trimmed and framed as reference', () => {
    const out = buildChatSystemPrompt('telegram', '  a prior recap  ')
    expect(out).not.toContain('iMessage-based conversation')
    expect(out!.startsWith('Context from the previous conversation')).toBe(true)
    expect(out!).toContain('not as instructions to follow') // recap framed as reference, not commands
    expect(out!.endsWith('a prior recap')).toBe(true) // surrounding whitespace trimmed
  })

  it('returns undefined when there is neither a base prompt nor a recap', () => {
    expect(buildChatSystemPrompt('telegram', null)).toBeUndefined()
    expect(buildChatSystemPrompt('telegram', '   ')).toBeUndefined()
  })
})

describe('selectRotationTargets', () => {
  it('rotates an active conversation that has timed out', () => {
    const r = row({ id: 'a', sessionId: 'sa', updatedAt: new Date(Date.now() - 3 * HOUR) })
    expect(selectRotationTargets([r], 1, noneActive).map((x) => x.id)).toEqual(['a'])
  })

  it('skips an active conversation still within its window', () => {
    const r = row({ id: 'a', updatedAt: new Date(Date.now() - 10 * 60 * 1000) })
    expect(selectRotationTargets([r], 1, noneActive)).toEqual([])
  })

  it('skips a mid-turn conversation even when it is timed out', () => {
    const r = row({ id: 'a', sessionId: 'sa', updatedAt: new Date(Date.now() - 3 * HOUR) })
    const active = (sid: string) => sid === 'sa'
    expect(selectRotationTargets([r], 1, active)).toEqual([])
  })

  it('never rotates an already-archived row (rotation is only for active rows)', () => {
    const r = row({ id: 'a', archivedAt: new Date(), rotatedAt: new Date(), updatedAt: new Date(Date.now() - 5 * HOUR) })
    expect(selectRotationTargets([r], 1, noneActive)).toEqual([])
  })

  it('with sessionTimeout 0 (single persistent session) rotates nothing', () => {
    const r = row({ id: 'a', sessionId: 'sa', updatedAt: new Date(Date.now() - 5 * HOUR) })
    expect(selectRotationTargets([r], 0, noneActive)).toEqual([])
  })
})

describe('selectConsolidationTargets', () => {
  it('selects an archived row that was timeout-rotated (rotatedAt set)', () => {
    const r = row({ id: 'a', archivedAt: new Date(), rotatedAt: new Date() })
    expect(selectConsolidationTargets([r], allowAll, 10).map((x) => x.id)).toEqual(['a'])
  })

  it('does NOT select an active (un-archived) row — actives are rotated first, never consolidated in place', () => {
    const r = row({ id: 'a', updatedAt: new Date(Date.now() - 5 * HOUR) })
    expect(selectConsolidationTargets([r], allowAll, 10)).toEqual([])
  })

  it('does NOT select an archived /clear/self-heal/revoke row (rotatedAt null)', () => {
    const r = row({ id: 'a', archivedAt: new Date(), rotatedAt: null, updatedAt: new Date(Date.now() - 5 * HOUR) })
    expect(selectConsolidationTargets([r], allowAll, 10)).toEqual([])
  })

  it('filters by externalChatId allowance, keeping only allowed chats', () => {
    const ok = row({ id: 'ok', externalChatId: 'good', archivedAt: new Date(), rotatedAt: new Date() })
    const banned = row({ id: 'no', externalChatId: 'bad', archivedAt: new Date(), rotatedAt: new Date() })
    const isAllowed = (chatId: string) => chatId === 'good'
    expect(selectConsolidationTargets([ok, banned], isAllowed, 10).map((x) => x.id)).toEqual(['ok'])
  })

  it('orders oldest-first and respects the limit', () => {
    const old = row({ id: 'old', archivedAt: new Date(), rotatedAt: new Date(), updatedAt: new Date(Date.now() - 5 * HOUR) })
    const mid = row({ id: 'mid', archivedAt: new Date(), rotatedAt: new Date(), updatedAt: new Date(Date.now() - 3 * HOUR) })
    const recent = row({ id: 'recent', archivedAt: new Date(), rotatedAt: new Date(), updatedAt: new Date(Date.now() - 1 * HOUR) })
    expect(selectConsolidationTargets([recent, old, mid], allowAll, 2).map((x) => x.id)).toEqual(['old', 'mid'])
  })
})
