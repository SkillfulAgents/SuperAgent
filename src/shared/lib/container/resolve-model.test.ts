import { describe, it, expect, vi, beforeEach } from 'vitest'

// getActiveLlmProvider reads settings for the active provider id; stub it so
// the host-side hint lookup is deterministic.
const settingsMock = vi.fn()
vi.mock('../config/settings', () => ({
  getSettings: () => settingsMock(),
  getModelCatalogSettings: () => settingsMock().modelCatalog ?? {},
}))

import {
  getContainerModelPromptHints,
  getContainerUnsupportedTools,
  WEB_SEARCH_TOOLS,
  IMAGE_EMITTING_TOOLS,
} from './resolve-model'

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

describe('getContainerUnsupportedTools', () => {
  it('returns the web tools for a model that does not support web search', () => {
    // Inject a no-web-search model via catalog overrides for the active provider.
    settingsMock.mockReturnValue({
      llmProvider: 'platform',
      modelCatalog: {
        platform: {
          overrides: [
            { id: 'no-web-1', label: 'No Web', supportedEfforts: ['low'], supportsWebSearch: false },
          ],
        },
      },
    })
    expect(getContainerUnsupportedTools('no-web-1')).toEqual([...WEB_SEARCH_TOOLS])
  })

  it('returns the image-emitting tools for a model that does not support image input', () => {
    settingsMock.mockReturnValue({
      llmProvider: 'platform',
      modelCatalog: {
        platform: {
          overrides: [
            { id: 'no-image-1', label: 'No Image', supportedEfforts: ['low'], supportsImageInput: false },
          ],
        },
      },
    })
    expect(getContainerUnsupportedTools('no-image-1')).toEqual([...IMAGE_EMITTING_TOOLS])
  })

  it('combines web and image bans when the model supports neither', () => {
    settingsMock.mockReturnValue({
      llmProvider: 'platform',
      modelCatalog: {
        platform: {
          overrides: [
            {
              id: 'no-web-no-image',
              label: 'Text Only',
              supportedEfforts: ['low'],
              supportsWebSearch: false,
              supportsImageInput: false,
            },
          ],
        },
      },
    })
    expect(getContainerUnsupportedTools('no-web-no-image')).toEqual([
      ...WEB_SEARCH_TOOLS,
      ...IMAGE_EMITTING_TOOLS,
    ])
  })

  it('returns nothing when the model supports both or capability is unknown', () => {
    // Built-in Claude entry leaves both flags unset (assume supported).
    expect(getContainerUnsupportedTools('claude-opus-4-8')).toEqual([])
    expect(getContainerUnsupportedTools('nope')).toEqual([])
    expect(getContainerUnsupportedTools(undefined)).toEqual([])
  })
})
