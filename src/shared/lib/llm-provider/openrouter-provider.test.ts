import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// getEffectiveApiKey reads settings; stub so the provider is configured.
const settingsMock = vi.fn()
vi.mock('../config/settings', () => ({
  getSettings: () => settingsMock(),
  getModelCatalogSettings: () => settingsMock().modelCatalog ?? {},
}))

import { OpenRouterLlmProvider } from './openrouter-provider'
import { GPT_TOOL_USE_PROMPT_HINTS } from './model-prompt-hints'

const provider = new OpenRouterLlmProvider()

function stubFetch(body: unknown, init?: { ok?: boolean; status?: number }) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    json: async () => body,
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

beforeEach(() => {
  settingsMock.mockReturnValue({ apiKeys: { openrouterApiKey: 'test-key' } })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('OpenRouterLlmProvider.searchModels — listing mapping', () => {
  it('maps a Claude listing (tokenizer family, anthropic icon, no web-search flag/hints)', async () => {
    stubFetch({
      data: [
        {
          id: 'anthropic/claude-opus-4',
          name: 'Anthropic: Claude Opus 4',
          description: 'Most capable Claude model.',
          context_length: 200000,
          architecture: { tokenizer: 'Claude' },
          pricing: { prompt: '0.000015', completion: '0.000075' },
        },
      ],
    })

    const [model] = await provider.searchModels('claude')

    // Claude models are served by Anthropic, so the web-search flag and GPT
    // prompt hints are omitted entirely (not set to a falsy value).
    expect(model).toEqual({
      id: 'anthropic/claude-opus-4',
      label: 'Anthropic: Claude Opus 4',
      family: 'claude',
      icon: 'anthropic',
      blurb: 'Most capable Claude model.',
      supportedEfforts: ['low', 'medium', 'high'],
      pricing: { inputPerMtok: 15, outputPerMtok: 75 },
      contextWindow: 200000,
    })
    expect(model).not.toHaveProperty('supportsWebSearch')
    expect(model).not.toHaveProperty('promptHints')
  })

  it('maps a GPT listing with supportsWebSearch=false and GPT prompt hints', async () => {
    stubFetch({
      data: [
        {
          id: 'openai/gpt-5.5',
          name: 'OpenAI: GPT-5.5',
          description: 'Flagship GPT.',
          context_length: 400000,
          architecture: { input_modalities: ['text', 'image'] },
          pricing: { prompt: '0.0000025', completion: '0.00001' },
        },
      ],
    })

    const [model] = await provider.searchModels('gpt')

    expect(model).toMatchObject({
      id: 'openai/gpt-5.5',
      family: 'gpt', // inferred from the slug when no tokenizer is present
      icon: 'openai',
      supportsWebSearch: false,
      supportsImageInput: true,
      promptHints: GPT_TOOL_USE_PROMPT_HINTS,
      pricing: { inputPerMtok: 2.5, outputPerMtok: 10 },
      contextWindow: 400000,
    })
  })

  it('reports image-input support from advertised input modalities', async () => {
    stubFetch({
      data: [
        { id: 'a/vision', name: 'Vision', architecture: { input_modalities: ['text', 'image'] } },
        { id: 'b/text-only', name: 'Text Only', architecture: { input_modalities: ['text'] } },
        { id: 'c/unknown', name: 'Unknown' }, // no architecture → support unknown
      ],
    })

    const [vision, textOnly, unknown] = await provider.searchModels('x')

    expect(vision.supportsImageInput).toBe(true)
    expect(textOnly.supportsImageInput).toBe(false)
    expect(unknown).not.toHaveProperty('supportsImageInput')
  })

  it('flags a generic non-Claude model for web search but adds no GPT hints', async () => {
    stubFetch({ data: [{ id: 'deepseek/deepseek-chat', name: 'DeepSeek Chat' }] })

    const [model] = await provider.searchModels('deepseek')

    expect(model.family).toBe('deepseek')
    expect(model.icon).toBeUndefined() // unknown vendor → no bundled icon
    expect(model.supportsWebSearch).toBe(false)
    expect(model).not.toHaveProperty('promptHints')
  })

  it('infers family from the slug first segment, version digits included', async () => {
    stubFetch({ data: [{ id: 'qwen/qwen3-max', name: 'Qwen3 Max' }] })

    const [model] = await provider.searchModels('qwen')

    // Documents the real behavior: the slug's first hyphen segment, so
    // 'qwen3-max' → 'qwen3' (not 'qwen').
    expect(model.family).toBe('qwen3')
  })

  it('maps the z-ai vendor to the zai icon', async () => {
    stubFetch({ data: [{ id: 'z-ai/glm-4.6', name: 'GLM 4.6' }] })

    const [model] = await provider.searchModels('glm')

    expect(model.icon).toBe('zai')
    expect(model.family).toBe('glm')
  })

  it('maps the x-ai vendor to the xai icon', async () => {
    stubFetch({ data: [{ id: 'x-ai/grok-4.5', name: 'xAI: Grok 4.5' }] })

    const [model] = await provider.searchModels('grok')

    expect(model.icon).toBe('xai')
    expect(model.family).toBe('grok')
  })

  it('omits pricing unless both prompt and completion are present', async () => {
    stubFetch({ data: [{ id: 'x/y', name: 'Y', pricing: { prompt: '0.000001' } }] })

    const [model] = await provider.searchModels('x')

    expect(model).not.toHaveProperty('pricing')
  })

  it('truncates long descriptions to a 180-char blurb', async () => {
    stubFetch({ data: [{ id: 'x/y', name: 'Y', description: 'a'.repeat(300) }] })

    const [model] = await provider.searchModels('x')

    expect(model.blurb).toHaveLength(180)
    expect(model.blurb?.endsWith('...')).toBe(true)
  })

  it('drops listings without an id and caps the result at 25', async () => {
    const data = [
      { name: 'No Id At All' },
      ...Array.from({ length: 30 }, (_, i) => ({ id: `vendor/model-${i}`, name: `Model ${i}` })),
    ]
    stubFetch({ data })

    const results = await provider.searchModels('m')

    expect(results).toHaveLength(25)
    expect(results.every((m) => m.id.startsWith('vendor/model-'))).toBe(true)
  })

  it('sends the API key and the expected query params', async () => {
    const fetchMock = stubFetch({ data: [] })

    await provider.searchModels('claude opus')

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('https://openrouter.ai/api/v1/models')
    expect(url).toContain('q=claude+opus')
    expect(url).toContain('output_modalities=text')
    expect(url).toContain('sort=most-popular')
    expect(init.headers).toMatchObject({ Authorization: 'Bearer test-key' })
  })
})

describe('OpenRouterLlmProvider.searchModels — error paths', () => {
  it('throws when no API key is configured', async () => {
    settingsMock.mockReturnValue({})
    const previous = process.env.OPENROUTER_API_KEY
    delete process.env.OPENROUTER_API_KEY
    try {
      await expect(provider.searchModels('x')).rejects.toThrow('OpenRouter API key not configured')
    } finally {
      if (previous !== undefined) process.env.OPENROUTER_API_KEY = previous
    }
  })

  it('throws with the status code on a non-OK response', async () => {
    stubFetch({}, { ok: false, status: 503 })
    await expect(provider.searchModels('x')).rejects.toThrow('OpenRouter model search failed (503)')
  })
})

describe('OpenRouterLlmProvider — capabilities and defaults', () => {
  it('opts into model search and exposes bare-alias purpose defaults', () => {
    expect(provider.supportsModelSearch).toBe(true)
    expect(provider.getDefaultModel('summarizer')).toBe('haiku')
    expect(provider.getDefaultModel('agent')).toBe('sonnet')
    expect(provider.getDefaultModel('browser')).toBe('sonnet')
    expect(provider.getDefaultModel('dashboard')).toBe('opus')
  })
})
