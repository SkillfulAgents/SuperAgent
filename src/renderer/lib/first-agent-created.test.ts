// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { claimFirstAgentCreated, resetFirstAgentCreatedMemoryForTest } from './first-agent-created'

vi.mock('@renderer/lib/error-reporting', () => ({
  captureRendererException: vi.fn(),
}))

describe('claimFirstAgentCreated', () => {
  beforeEach(() => {
    localStorage.clear()
    resetFirstAgentCreatedMemoryForTest()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns true on the first claim and false afterwards', () => {
    expect(claimFirstAgentCreated('user-a')).toBe(true)
    expect(claimFirstAgentCreated('user-a')).toBe(false)
  })

  it('tracks users independently', () => {
    expect(claimFirstAgentCreated('user-a')).toBe(true)
    expect(claimFirstAgentCreated('user-b')).toBe(true)
  })

  it('persists the claim across the in-memory cache reset (localStorage)', () => {
    expect(claimFirstAgentCreated('user-a')).toBe(true)
    resetFirstAgentCreatedMemoryForTest()
    expect(claimFirstAgentCreated('user-a')).toBe(false)
  })

  it('falls back to session-scoped dedup when localStorage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied') })

    expect(claimFirstAgentCreated('user-a')).toBe(true)
    expect(claimFirstAgentCreated('user-a')).toBe(false)
  })
})
