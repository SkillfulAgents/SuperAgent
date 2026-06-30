import { describe, it, expect, vi } from 'vitest'

// The pure selector under test does not touch the DB, but importing the manager
// module pulls in its dependency graph — stub the heavy ones so the import is
// side-effect free (mirrors chat-integration-manager-restore-filter.test.ts).
vi.mock('../db', () => ({ get db() { return undefined }, get sqlite() { return undefined } }))
vi.mock('@shared/lib/services/chat-integration-service', () => ({
  getChatIntegration: vi.fn(),
  listStartupChatIntegrations: vi.fn().mockReturnValue([]),
  updateChatIntegrationStatus: vi.fn(),
}))
vi.mock('@shared/lib/container/container-manager', () => ({ containerManager: { ensureRunning: vi.fn() } }))
vi.mock('@shared/lib/proxy/review-manager', () => ({ reviewManager: { submitDecision: vi.fn() } }))
vi.mock('@shared/lib/error-reporting', () => ({ captureException: vi.fn(), addErrorBreadcrumb: vi.fn() }))

import { selectConsolidationTargets } from './chat-integration-manager'
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

describe('selectConsolidationTargets', () => {
  it('selects an active conversation that has timed out', () => {
    const r = row({ id: 'a', sessionId: 'sa', updatedAt: new Date(Date.now() - 3 * HOUR) })
    expect(selectConsolidationTargets([r], 1, noneActive, allowAll, 10).map((x) => x.id)).toEqual(['a'])
  })

  it('selects an archived row that was timeout-rotated (rotatedAt set)', () => {
    const r = row({ id: 'a', archivedAt: new Date(), rotatedAt: new Date() })
    expect(selectConsolidationTargets([r], 1, noneActive, allowAll, 10).map((x) => x.id)).toEqual(['a'])
  })

  it('does NOT select an archived /clear/self-heal/revoke row (rotatedAt null) even when its updatedAt looks timed out', () => {
    // The P1 regression: isSessionTimedOut only checks updatedAt, so without the
    // archivedAt==null gate this old, archived, non-rotated row would slip through.
    const r = row({ id: 'a', archivedAt: new Date(), rotatedAt: null, updatedAt: new Date(Date.now() - 5 * HOUR) })
    expect(selectConsolidationTargets([r], 1, noneActive, allowAll, 10)).toEqual([])
  })

  it('skips an active conversation still within its window', () => {
    const r = row({ id: 'a', updatedAt: new Date(Date.now() - 10 * 60 * 1000) })
    expect(selectConsolidationTargets([r], 1, noneActive, allowAll, 10)).toEqual([])
  })

  it('skips a mid-turn conversation even when it is timed out', () => {
    const r = row({ id: 'a', sessionId: 'sa', updatedAt: new Date(Date.now() - 3 * HOUR) })
    const active = (sid: string) => sid === 'sa'
    expect(selectConsolidationTargets([r], 1, active, allowAll, 10)).toEqual([])
  })

  it('with sessionTimeout 0, still drains archived+rotated rows but never active rows', () => {
    const archivedRotated = row({ id: 'a', archivedAt: new Date(), rotatedAt: new Date() })
    const activeOld = row({ id: 'b', sessionId: 'sb', updatedAt: new Date(Date.now() - 5 * HOUR) })
    const ids = selectConsolidationTargets([archivedRotated, activeOld], 0, noneActive, allowAll, 10).map((x) => x.id)
    expect(ids).toEqual(['a'])
  })

  it('filters by externalChatId allowance, keeping only allowed chats', () => {
    const ok = row({ id: 'ok', externalChatId: 'good', archivedAt: new Date(), rotatedAt: new Date() })
    const banned = row({ id: 'no', externalChatId: 'bad', archivedAt: new Date(), rotatedAt: new Date() })
    const isAllowed = (chatId: string) => chatId === 'good'
    const ids = selectConsolidationTargets([ok, banned], 1, noneActive, isAllowed, 10).map((x) => x.id)
    expect(ids).toEqual(['ok'])
  })

  it('orders oldest-first and respects the limit', () => {
    const old = row({ id: 'old', archivedAt: new Date(), rotatedAt: new Date(), updatedAt: new Date(Date.now() - 5 * HOUR) })
    const mid = row({ id: 'mid', archivedAt: new Date(), rotatedAt: new Date(), updatedAt: new Date(Date.now() - 3 * HOUR) })
    const recent = row({ id: 'recent', archivedAt: new Date(), rotatedAt: new Date(), updatedAt: new Date(Date.now() - 1 * HOUR) })
    const picked = selectConsolidationTargets([recent, old, mid], 1, noneActive, allowAll, 2).map((x) => x.id)
    expect(picked).toEqual(['old', 'mid'])
  })
})
