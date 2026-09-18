import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  summarize: vi.fn(), client: {}, resolve: vi.fn(() => 'resolved-summary-model'),
  settings: { apiKeys: { openaiApiKey: 'byok-test-key' } },
}))
vi.mock('../config/settings', () => ({
  getSettings: () => mocks.settings,
  getEffectiveModels: () => ({ summarizerModel: 'configured-summary-model' }),
}))
vi.mock('../llm-provider/helpers', () => ({ getConfiguredLlmClient: () => mocks.client, createSummarizerText: mocks.summarize }))
vi.mock('../llm-provider', () => ({ resolveActiveProviderModel: mocks.resolve }))
import { OpenaiVoiceProvider } from './openai-provider'
import type { VoiceHistory } from './conversation-types'

const provider = new OpenaiVoiceProvider()
const fetchMock = vi.fn()
beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal('fetch', fetchMock) })

 describe('OpenAI Live BYOK', () => {
  it('creates a client-delegated Live session with a host-only key and bounded history', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ session: { id: 'live_test' }, transport: { sdp: 'answer' }, secret: 'never-return' })))
    const result = await provider.createLiveSession('offer', [{ role: 'user', content: 'hello' }])
    expect(fetchMock).toHaveBeenCalledWith('https://api.openai.com/v1/live/sessions', expect.objectContaining({
      headers: { Authorization: 'Bearer byok-test-key', 'Content-Type': 'application/json' },
    }))
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body).toMatchObject({ session: { model: 'gpt-live-1', delegation: { type: 'client' }, store: false,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
    }, transport: { type: 'webrtc', sdp: 'offer' } })
    expect(body.session.client.data_channel.allowed_client_events).not.toContain('session.update')
    expect(result).toEqual({ session: { id: 'live_test' }, transport: { type: 'webrtc', sdp: 'answer' } })
    expect(provider.getConversationEngine()).toBe('openai-live')
    expect(provider.supportsTts()).toBe(true)
  })

  it('sends agent identity, custom instructions, and account handoff guidance as session instructions', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ session: { id: 'live_test' }, transport: { sdp: 'answer' } })))
    await provider.createLiveSession('offer', [], {
      name: 'Ada', description: 'Research assistant', instructions: 'Speak in Spanish. Ask before purchases.',
      capabilityPolicies: { subagents: 'block', workflows: 'review' },
    })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.session.instructions).toContain('Ada')
    expect(body.session.instructions).toContain('Speak in Spanish. Ask before purchases.')
    expect(body.session.instructions).toContain('connecting an account')
    expect(body.session.instructions).toContain('subagents: disabled')
    expect(body.session.instructions).toContain('workflows, subject to user approval')
    expect(body.session.delegation).toEqual({ type: 'client' })
    expect(body.session.input).toEqual([])
  })

  it('reuses the configured summarizer and validates its normalized request', async () => {
    mocks.summarize.mockResolvedValue('{"action":"message","text":"Check Thursday instead of Friday."}')
    expect(await provider.mapLiveConversation({ kind: 'request', transcript: 'user: Actually Thursday.', history: [], previousRequest: 'Check Friday.', agentBusy: true }))
      .toEqual({ action: 'message', text: 'Check Thursday instead of Friday.' })
    expect(mocks.resolve).toHaveBeenCalledWith('configured-summary-model', 'summarizer')
    expect(mocks.summarize).toHaveBeenCalledWith(mocks.client, expect.objectContaining({ model: 'resolved-summary-model', output_config: { format: expect.objectContaining({ type: 'json_schema', schema: expect.objectContaining({ required: ['action', 'text'], additionalProperties: false }) }) } }), expect.any(AbortSignal))
  })

  it.each(['not JSON', '{"action":"execute","text":"bad"}', '{"action":"message","text":""}'])('rejects unusable mappings: %s', async (text) => {
    mocks.summarize.mockResolvedValue(text)
    await expect(provider.mapLiveConversation({ kind: 'request', transcript: 'user: hello', history: [], previousRequest: '', agentBusy: false })).rejects.toThrow()
  })

  it('uses the summarizer for outgoing updates and propagates aborts', async () => {
    mocks.summarize.mockResolvedValue('The search is still running.')
    expect(await provider.mapLiveConversation({ kind: 'reply', text: 'Searching...' })).toEqual({ text: 'The search is still running.' })
    const abort = new AbortController()
    abort.abort()
    await provider.mapLiveConversation({ kind: 'reply', text: 'Searching...' }, abort.signal)
    expect(mocks.summarize.mock.calls.at(-1)?.[2].aborted).toBe(true)
  })

  it('does not expose an upstream error body', async () => {
    fetchMock.mockResolvedValue(new Response('sensitive upstream body', { status: 403 }))
    const err = await provider.createLiveSession('offer', []).then(() => undefined, (e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain('rejected the API key')
    expect((err as Error).message).not.toContain('sensitive')
  })
  it('uses the live-session hint for non-auth upstream failures', async () => {
    fetchMock.mockResolvedValue(new Response('sensitive upstream body', { status: 500 }))
    const err = await provider.createLiveSession('offer', []).then(() => undefined, (e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain('GPT-Live access')
    expect((err as Error).message).not.toContain('sensitive')
  })
  it('seeds Live with a token-budgeted window of recent turns, clipping long turns to their head', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ session: { id: 'live_test' }, transport: { sdp: 'answer' } })))
    const history: VoiceHistory = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `turn ${i} ${'detail '.repeat(20)}` }))
    history.push({ role: 'assistant', content: 'CONCLUSION ' + 'x'.repeat(3900) })
    await provider.createLiveSession('offer', history)
    const input = JSON.parse(fetchMock.mock.calls[0][1].body).session.input as Array<{ role: string; content: Array<{ type: string; text: string }> }>
    expect(input).toHaveLength(41)
    expect(input[0].content[0].text.startsWith('turn 0')).toBe(true)
    expect(input.at(-1)?.content[0].text.startsWith('CONCLUSION')).toBe(true)
    expect(input.at(-1)?.content[0].text.length).toBeLessThan(1600)
    expect(input.at(-1)?.content[0].type).toBe('text')
    expect(input[0].content[0].type).toBe('input_text')
  })

  it('bounds the history handed to the request summarizer with the same window', async () => {
    mocks.summarize.mockResolvedValue('{"action":"none","text":""}')
    const history: VoiceHistory = Array.from({ length: 128 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'y'.repeat(4000) }))
    await provider.mapLiveConversation({ kind: 'request', transcript: 'user: ok', history, previousRequest: '', agentBusy: false })
    const sent = JSON.parse(mocks.summarize.mock.calls[0][1].messages[0].content)
    expect(sent.history.length).toBeLessThan(128)
    expect(sent.history.every((m: { content: string }) => m.content.length < 1600)).toBe(true)
  })

  it('starts and maps sessions whose history quotes tokenizer markers', async () => {
    const history: VoiceHistory = [{ role: 'user', content: 'What does <|endoftext|> mean?' }, { role: 'assistant', content: 'It marks <|endoftext|> the end of a document.' }]
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ session: { id: 'live_test' }, transport: { sdp: 'answer' } })))
    await provider.createLiveSession('offer', history)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).session.input).toHaveLength(2)
    mocks.summarize.mockResolvedValue('{"action":"none","text":""}')
    await provider.mapLiveConversation({ kind: 'request', transcript: 'user: ok', history, previousRequest: '', agentBusy: false })
    expect(JSON.parse(mocks.summarize.mock.calls[0][1].messages[0].content).history).toEqual(history)
  })

  it('omits empty and whitespace-only turns from upstream history', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ session: { id: 'live_test' }, transport: { sdp: 'answer' } })))
    await provider.createLiveSession('offer', [
      { role: 'user', content: 'Research this' }, { role: 'assistant', content: '' },
      { role: 'assistant', content: '  ' }, { role: 'assistant', content: 'Found it' },
    ])
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.session.input.map((entry: { content: Array<{ text: string }> }) => entry.content[0].text)).toEqual(['Research this', 'Found it'])
  })

})
