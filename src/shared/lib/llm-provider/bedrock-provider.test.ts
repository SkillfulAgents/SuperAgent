import { describe, expect, it, vi } from 'vitest'

vi.mock('@anthropic-ai/sdk', () => ({ default: class {} }))
vi.mock('../config/settings', () => ({ getSettings: () => ({}) }))

import { BedrockLlmProvider } from './bedrock-provider'

describe('BedrockLlmProvider — tool search', () => {
  // Bedrock serves Claude models, and the CLI's non-first-party guard never
  // fires in Bedrock mode — so unset would mean on anyway. Declared for intent.
  it('turns ENABLE_TOOL_SEARCH on', () => {
    expect(new BedrockLlmProvider().toolSearchEnv()).toBe('true')
  })
})

describe('BedrockLlmProvider — API version', () => {
  // Bedrock serves 2026-10-21 (SDK 1.x's default) only for Claude 4.7+, and
  // helper calls run Haiku 4.5, so every call stays on SDK 0.x's version.
  it.each([
    ['a Bedrock API key', { bedrockApiKey: 'bedrock-key' }],
    ['AWS access keys', { bedrockAccessKeyId: 'AKIDEXAMPLE', bedrockSecretAccessKey: 'secret' }],
  ])('sends bedrock-2023-05-31 with %s', async (_, apiKeys) => {
    const bodies: Array<Record<string, unknown>> = []
    const headers: Headers[] = []
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const sent = new Request(url, init)
      headers.push(sent.headers)
      bodies.push(await sent.json())
      return new Response(JSON.stringify({ id: 'msg', type: 'message', role: 'assistant', model: 'm', content: [], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }), { headers: { 'Content-Type': 'application/json' } })
    })
    const provider = new BedrockLlmProvider({ apiKeys: { ...apiKeys, bedrockRegion: 'us-east-1' }, env: {} })
    await provider.createClient().withOptions({ fetch }).messages.create({
      model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', max_tokens: 1, messages: [{ role: 'user', content: 'Hi' }],
    })
    expect(bodies[0].anthropic_version).toBe('bedrock-2023-05-31')
    expect(headers[0].get('anthropic-version')).toBeNull()
    expect(headers[0].get('Authorization')).toMatch('bedrockApiKey' in apiKeys ? /^Bearer bedrock-key$/ : /^AWS4-HMAC-SHA256 /)
  })
})
