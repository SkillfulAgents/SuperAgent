import { describe, it, expect, vi, beforeEach } from 'vitest'

// getActiveLlmProvider reads settings for the active provider id; stub it so
// the host-side hint lookup is deterministic.
const settingsMock = vi.fn()
vi.mock('../config/settings', () => ({
  getSettings: () => settingsMock(),
  getModelCatalogSettings: () => settingsMock().modelCatalog ?? {},
}))

import {
  getContainerModelRuntimeConfig,
  WEB_SEARCH_TOOLS,
} from './resolve-model'

beforeEach(() => {
  settingsMock.mockReturnValue({ llmProvider: 'platform' })
})

describe('getContainerModelRuntimeConfig modelPromptHints', () => {
  it('returns GPT tool-use hints for a resolved Platform GPT id', () => {
    const hints = getContainerModelRuntimeConfig('gpt-5.5').modelPromptHints
    expect(hints.some((h) => h.includes('ToolSearch'))).toBe(true)
    expect(hints.some((h) => h.includes('pages as an empty string'))).toBe(true)
  })

  it('returns no hints for a Claude model on the active provider', () => {
    expect(getContainerModelRuntimeConfig('claude-opus-4-8').modelPromptHints).toEqual([])
  })

  it('returns no hints for an undefined or unknown model', () => {
    expect(getContainerModelRuntimeConfig(undefined).modelPromptHints).toEqual([])
    expect(getContainerModelRuntimeConfig('nope').modelPromptHints).toEqual([])
  })
})

describe('getContainerModelRuntimeConfig unsupportedTools', () => {
  it('returns web tools for Fireworks-hosted Platform models', () => {
    expect(getContainerModelRuntimeConfig('glm-5.2').unsupportedTools).toEqual([...WEB_SEARCH_TOOLS])
    expect(getContainerModelRuntimeConfig('kimi-k2.6').unsupportedTools).toEqual([...WEB_SEARCH_TOOLS])
    expect(getContainerModelRuntimeConfig('kimi-k2.7-code').unsupportedTools).toEqual([...WEB_SEARCH_TOOLS])
  })

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
    expect(getContainerModelRuntimeConfig('no-web-1').unsupportedTools).toEqual([...WEB_SEARCH_TOOLS])
  })

  it('does not globally ban image-emitting tools for a model that does not support image input', () => {
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
    expect(getContainerModelRuntimeConfig('no-image-1').unsupportedTools).toEqual([])
  })

  it('bans only web tools when the model supports neither web search nor image input', () => {
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
    expect(getContainerModelRuntimeConfig('no-web-no-image').unsupportedTools).toEqual([...WEB_SEARCH_TOOLS])
  })

  it('returns nothing when the model supports web tools or capability is unknown', () => {
    // Built-in Claude entry leaves both flags unset (assume supported).
    expect(getContainerModelRuntimeConfig('claude-opus-4-8').unsupportedTools).toEqual([])
    expect(getContainerModelRuntimeConfig('nope').unsupportedTools).toEqual([])
    expect(getContainerModelRuntimeConfig(undefined).unsupportedTools).toEqual([])
  })

  it('conservatively bans web tools for unknown non-Claude OpenRouter pins', () => {
    settingsMock.mockReturnValue({ llmProvider: 'openrouter' })
    expect(getContainerModelRuntimeConfig('openai/gpt-6.0-preview').unsupportedTools).toEqual([...WEB_SEARCH_TOOLS])
    expect(getContainerModelRuntimeConfig('anthropic/claude-sonnet-4.6').unsupportedTools).toEqual([])
  })
})
