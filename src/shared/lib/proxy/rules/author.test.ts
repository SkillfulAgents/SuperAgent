import { beforeEach, describe, expect, it, vi } from 'vitest'

const llm = vi.hoisted(() => ({
  direct: true,
  create: vi.fn(),
  summarize: vi.fn(),
}))

vi.mock('@shared/lib/config/settings', () => ({
  getEffectiveModels: () => ({ agentModel: 'opus', summarizerModel: 'haiku' }),
}))
vi.mock('@shared/lib/llm-provider', () => ({
  getActiveLlmProvider: () => ({
    supportsDirectApi: llm.direct,
    getApiKeyStatus: () => ({ isConfigured: true }),
    createClient: () => ({ messages: { create: llm.create } }),
  }),
  resolveActiveProviderModel: (model: string) => `model-${model}`,
}))
vi.mock('@shared/lib/llm-provider/helpers', () => ({
  getConfiguredLlmClient: async () => ({ helper: true }),
  createSummarizerText: llm.summarize,
}))

import { restateRule } from './author'

const draft = { kind: 'api' as const, effect: 'allow' as const, patterns: ['GET /x'], code: '() => true' }
const answer = JSON.stringify({ name: 'Reads of x', restatement: 'Lets GET /x through. Everything else goes to review.' })

beforeEach(() => {
  llm.direct = true
  llm.create.mockReset()
  llm.summarize.mockReset()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('rule authoring model', () => {
  it('uses the default model when the provider can be called directly', async () => {
    llm.create.mockResolvedValue({ content: [{ type: 'text', text: answer }] })
    expect(await restateRule(draft)).toMatchObject({ name: 'Reads of x' })
    expect(llm.create.mock.calls[0][0].model).toBe('model-opus')
    expect(llm.summarize).not.toHaveBeenCalled()
  })

  it('falls back to the summarizer model when the default model fails', async () => {
    llm.create.mockRejectedValue(new Error('400 output_config is not supported'))
    llm.summarize.mockResolvedValue(answer)
    expect(await restateRule(draft)).toMatchObject({ name: 'Reads of x' })
    expect(llm.summarize.mock.calls[0][1].model).toBe('model-haiku')
  })

  it('uses the summarizer model when the provider has no direct API', async () => {
    llm.direct = false
    llm.summarize.mockResolvedValue(answer)
    expect(await restateRule(draft)).toMatchObject({ name: 'Reads of x' })
    expect(llm.create).not.toHaveBeenCalled()
    expect(llm.summarize.mock.calls[0][1].model).toBe('model-haiku')
  })
})
