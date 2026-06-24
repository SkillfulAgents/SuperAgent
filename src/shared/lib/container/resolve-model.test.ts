import { describe, it, expect, vi, beforeEach } from 'vitest'

// getActiveLlmProvider reads settings for the active provider id; stub it so
// the host-side hint lookup is deterministic.
const settingsMock = vi.fn()
vi.mock('../config/settings', () => ({
  getSettings: () => settingsMock(),
  getModelCatalogSettings: () => settingsMock().modelCatalog ?? {},
}))

import { getContainerModelPromptHints } from './resolve-model'

beforeEach(() => {
  settingsMock.mockReturnValue({ llmProvider: 'platform' })
})

describe('getContainerModelPromptHints', () => {
  it('returns GPT tool-use hints for a resolved Platform GPT id', () => {
    const hints = getContainerModelPromptHints('gpt-5.5')
    expect(hints.some((h) => h.includes('ToolSearch'))).toBe(true)
    expect(hints.some((h) => h.includes('pages as an empty string'))).toBe(true)
  })

  it('returns no hints for a Claude model on the active provider', () => {
    expect(getContainerModelPromptHints('claude-opus-4-8')).toEqual([])
  })

  it('returns no hints for an undefined or unknown model', () => {
    expect(getContainerModelPromptHints(undefined)).toEqual([])
    expect(getContainerModelPromptHints('nope')).toEqual([])
  })
})
