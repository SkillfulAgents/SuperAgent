import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The provider reads settings for its key/baseURL and the model catalog for its
// (empty) built-in list; stub both so tests are deterministic.
const settingsMock = vi.fn()
const catalogMock = vi.fn()
vi.mock('../config/settings', () => ({
  getSettings: () => settingsMock(),
  getModelCatalogSettings: () => catalogMock(),
}))

// Capture SDK construction + intercept messages.create for validateKey.
const messagesCreate = vi.fn()
const anthropicCtor = vi.fn()
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: (...args: unknown[]) => messagesCreate(...args) }
    constructor(opts: unknown) {
      anthropicCtor(opts)
    }
  },
}))

import { GenericLlmProvider, GENERIC_FALLBACK_MODEL } from './generic-provider'

const provider = new GenericLlmProvider()

const ENV_KEYS = ['GENERIC_API_KEY', 'GENERIC_BASE_URL', 'GENERIC_DEFAULT_MODEL'] as const
const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  settingsMock.mockReturnValue({ apiKeys: { genericApiKey: 'test-key', genericBaseUrl: 'https://proxy.example' } })
  catalogMock.mockReturnValue({})
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  vi.clearAllMocks()
})

describe('GenericLlmProvider — catalog and capabilities', () => {
  it('ships an empty built-in catalog and opts into model search', () => {
    expect(provider.getBuiltinCatalog()).toEqual([])
    expect(provider.supportsModelSearch).toBe(true)
  })
})

describe('GenericLlmProvider.getEffectiveBaseUrl', () => {
  it('prefers the settings baseURL over the env var', () => {
    process.env.GENERIC_BASE_URL = 'https://env.example'
    expect(provider.getEffectiveBaseUrl()).toBe('https://proxy.example')
  })

  it('falls back to GENERIC_BASE_URL when settings has none', () => {
    settingsMock.mockReturnValue({ apiKeys: {} })
    process.env.GENERIC_BASE_URL = 'https://env.example'
    expect(provider.getEffectiveBaseUrl()).toBe('https://env.example')
  })

  it('is undefined when neither is configured', () => {
    settingsMock.mockReturnValue({ apiKeys: {} })
    expect(provider.getEffectiveBaseUrl()).toBeUndefined()
  })
})

describe('GenericLlmProvider.getDefaultModel', () => {
  it('returns the first non-disabled user-added model', () => {
    catalogMock.mockReturnValue({
      generic: { overrides: [{ id: 'llama3.1' }, { id: 'mistral' }] },
    })
    expect(provider.getDefaultModel('agent')).toBe('llama3.1')
  })

  it('skips disabled user models', () => {
    catalogMock.mockReturnValue({
      generic: { overrides: [{ id: 'llama3.1', disabled: true }, { id: 'mistral' }] },
    })
    expect(provider.getDefaultModel('agent')).toBe('mistral')
  })

  it('honors GENERIC_DEFAULT_MODEL when no user models are configured', () => {
    process.env.GENERIC_DEFAULT_MODEL = 'my-default'
    expect(provider.getDefaultModel('agent')).toBe('my-default')
  })

  it('falls back to the placeholder when nothing is configured', () => {
    expect(provider.getDefaultModel('agent')).toBe(GENERIC_FALLBACK_MODEL)
  })
})

describe('GenericLlmProvider.getContainerEnvVars', () => {
  it('sets the Anthropic-wire env, rewriting localhost to the container host gateway', () => {
    settingsMock.mockReturnValue({
      apiKeys: { genericApiKey: 'k', genericBaseUrl: 'http://localhost:11434' },
    })
    expect(provider.getContainerEnvVars()).toEqual({
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_BASE_URL: 'http://host.docker.internal:11434',
      ANTHROPIC_AUTH_TOKEN: 'k',
    })
  })

  it('leaves a non-localhost baseURL untouched', () => {
    expect(provider.getContainerEnvVars().ANTHROPIC_BASE_URL).toBe('https://proxy.example')
  })
})

describe('GenericLlmProvider.createClient', () => {
  it('builds an Anthropic client with the baseURL and Bearer auth token', () => {
    provider.createClient()
    expect(anthropicCtor).toHaveBeenCalledWith({
      apiKey: '',
      baseURL: 'https://proxy.example',
      authToken: 'test-key',
    })
  })

  it('throws when the base URL is missing', () => {
    settingsMock.mockReturnValue({ apiKeys: { genericApiKey: 'k' } })
    expect(() => provider.createClient()).toThrow('base URL not configured')
  })

  it('throws when the API key is missing', () => {
    settingsMock.mockReturnValue({ apiKeys: { genericBaseUrl: 'https://proxy.example' } })
    expect(() => provider.createClient()).toThrow('API key not configured')
  })
})

describe('GenericLlmProvider.searchModels', () => {
  function stubFetch(body: unknown, init?: { ok?: boolean; status?: number }) {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: init?.ok ?? true,
      status: init?.status ?? 200,
      json: async () => body,
    })
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  afterEach(() => vi.unstubAllGlobals())

  it('lists ollama-shape entries and passes the Bearer key', async () => {
    const fetchMock = stubFetch({
      object: 'list',
      data: [
        { id: 'qwen3.6:27b-mlx', object: 'model' },
        { id: 'gemma3:270m', object: 'model' },
      ],
    })

    const results = await provider.searchModels('')

    expect(results).toEqual([
      { id: 'qwen3.6:27b-mlx', label: 'qwen3.6:27b-mlx', supportedEfforts: ['low', 'medium', 'high'], supportsWebSearch: false },
      { id: 'gemma3:270m', label: 'gemma3:270m', supportedEfforts: ['low', 'medium', 'high'], supportsWebSearch: false },
    ])
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://proxy.example/v1/models')
    expect(init.headers).toMatchObject({ Authorization: 'Bearer test-key' })
  })

  it('uses display_name as the label when present (Anthropic /v1/models shape)', async () => {
    stubFetch({
      data: [{ id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8' }],
    })

    const [model] = await provider.searchModels('')
    expect(model).toMatchObject({ id: 'claude-opus-4-8', label: 'Claude Opus 4.8' })
  })

  it('filters by substring against both id and label, case-insensitive', async () => {
    stubFetch({
      data: [
        { id: 'qwen3.6:27b-mlx' },
        { id: 'gemma3:270m' },
        { id: 'llama3.1', display_name: 'Meta Llama 3.1' },
      ],
    })

    const qwen = await provider.searchModels('QWEN')
    expect(qwen.map((m) => m.id)).toEqual(['qwen3.6:27b-mlx'])

    const meta = await provider.searchModels('meta')
    expect(meta.map((m) => m.id)).toEqual(['llama3.1'])
  })

  it('drops entries without an id and caps the result at 50', async () => {
    const data = [
      { object: 'model' },
      ...Array.from({ length: 60 }, (_, i) => ({ id: `model-${i}` })),
    ]
    stubFetch({ data })

    const results = await provider.searchModels('')
    expect(results).toHaveLength(50)
    expect(results.every((m) => m.id.startsWith('model-'))).toBe(true)
  })

  it('strips a trailing slash on the base URL before appending /v1/models', async () => {
    settingsMock.mockReturnValue({
      apiKeys: { genericApiKey: 'k', genericBaseUrl: 'https://proxy.example///' },
    })
    const fetchMock = stubFetch({ data: [] })

    await provider.searchModels('')
    const [url] = fetchMock.mock.calls[0] as [string]
    expect(url).toBe('https://proxy.example/v1/models')
  })

  it('throws a friendly message when the endpoint has no /v1/models (404)', async () => {
    stubFetch({}, { ok: false, status: 404 })
    await expect(provider.searchModels('')).rejects.toThrow('does not support model listing')
  })

  it('throws with the status code on other non-OK responses', async () => {
    stubFetch({}, { ok: false, status: 500 })
    await expect(provider.searchModels('')).rejects.toThrow('failed (500)')
  })

  it('surfaces a timeout message when the request aborts', async () => {
    const abort = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abort))
    await expect(provider.searchModels('')).rejects.toThrow(/timed out after 15s/)
  })

  it('throws when the base URL is missing', async () => {
    settingsMock.mockReturnValue({ apiKeys: { genericApiKey: 'k' } })
    await expect(provider.searchModels('')).rejects.toThrow('base URL not configured')
  })

  it('throws when the API key is missing', async () => {
    settingsMock.mockReturnValue({ apiKeys: { genericBaseUrl: 'https://proxy.example' } })
    await expect(provider.searchModels('')).rejects.toThrow('API key not configured')
  })
})

describe('GenericLlmProvider.validateKey', () => {
  function stubFetch(init: { ok?: boolean; status?: number } = {}) {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: init.ok ?? true,
      status: init.status ?? 200,
      json: async () => ({}),
    })
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  afterEach(() => vi.unstubAllGlobals())

  it('requires a base URL', async () => {
    settingsMock.mockReturnValue({ apiKeys: {} })
    expect(await provider.validateKey('key')).toEqual({ valid: false, error: 'Base URL is required' })
  })

  it('probes /v1/models on the inline baseURL and reports success without needing a real model id', async () => {
    settingsMock.mockReturnValue({ apiKeys: {} })
    const fetchMock = stubFetch({ ok: true, status: 200 })
    const result = await provider.validateKey('key', { baseUrl: 'http://localhost:11434' })
    expect(result).toEqual({ valid: true })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://localhost:11434/v1/models')
    expect(init.headers).toMatchObject({ Authorization: 'Bearer key' })
  })

  it('reports an auth-specific error on 401', async () => {
    stubFetch({ ok: false, status: 401 })
    const result = await provider.validateKey('bad')
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/Auth rejected.*401/)
  })

  it('reports an auth-specific error on 403', async () => {
    stubFetch({ ok: false, status: 403 })
    const result = await provider.validateKey('bad')
    expect(result.error).toMatch(/Auth rejected.*403/)
  })

  it('treats a 404 as reachable-but-not-listable (soft-passes so the user can proceed)', async () => {
    stubFetch({ ok: false, status: 404 })
    expect(await provider.validateKey('key')).toEqual({ valid: true })
  })

  it('reports the status code on other non-OK responses', async () => {
    stubFetch({ ok: false, status: 502 })
    expect(await provider.validateKey('key')).toEqual({ valid: false, error: 'Endpoint returned 502' })
  })

  it('surfaces a friendly message when the fetch fails outright', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))
    const result = await provider.validateKey('key')
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/Could not reach https:\/\/proxy\.example/)
  })

  it('surfaces a timeout message when the request aborts', async () => {
    const abort = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abort))
    const result = await provider.validateKey('key')
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/Timed out/)
  })
})
