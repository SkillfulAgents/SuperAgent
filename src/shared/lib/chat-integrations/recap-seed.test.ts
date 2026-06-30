import { describe, it, expect, vi } from 'vitest'

// Importing the manager pulls in its dependency graph — stub the heavy modules
// so the import is side-effect free (mirrors consolidation-sweep.test.ts).
vi.mock('../db', () => ({ get db() { return undefined }, get sqlite() { return undefined } }))
vi.mock('@shared/lib/services/chat-integration-service', () => ({
  getChatIntegration: vi.fn(),
  listStartupChatIntegrations: vi.fn().mockReturnValue([]),
  updateChatIntegrationStatus: vi.fn(),
}))
vi.mock('@shared/lib/container/container-manager', () => ({ containerManager: { ensureRunning: vi.fn() } }))
vi.mock('@shared/lib/proxy/review-manager', () => ({ reviewManager: { submitDecision: vi.fn() } }))
vi.mock('@shared/lib/error-reporting', () => ({ captureException: vi.fn(), addErrorBreadcrumb: vi.fn() }))

import { buildRecapSystemContext } from './chat-integration-manager'

describe('buildRecapSystemContext', () => {
  it('returns an empty string for null, empty or whitespace-only recaps', () => {
    expect(buildRecapSystemContext(null)).toBe('')
    expect(buildRecapSystemContext('')).toBe('')
    expect(buildRecapSystemContext('   ')).toBe('')
  })

  it('wraps a recap in a labeled "previous conversation" block', () => {
    const out = buildRecapSystemContext('User prefers terse replies.')
    expect(out).toContain('User prefers terse replies.')
    expect(out.toLowerCase()).toContain('previous conversation')
    expect(out.startsWith('Context from the previous conversation')).toBe(true)
  })

  it('trims surrounding whitespace from the recap', () => {
    const out = buildRecapSystemContext('  hello  ')
    expect(out.endsWith('hello')).toBe(true)
  })
})
