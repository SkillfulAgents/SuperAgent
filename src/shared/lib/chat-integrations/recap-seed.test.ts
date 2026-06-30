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

import { buildChatSystemPrompt } from './chat-integration-manager'

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
