import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

// ---------------------------------------------------------------------------
// Mock dependencies
// ---------------------------------------------------------------------------

const mockCreate = vi.fn()

vi.mock('../middleware/auth', () => ({
  Authenticated: () => async (_c: unknown, next: () => Promise<void>) => next(),
}))

vi.mock('@shared/lib/llm-provider/helpers', () => ({
  getConfiguredLlmClient: () => ({
    messages: { create: mockCreate },
  }),
}))

vi.mock('@shared/lib/llm-provider', () => ({
  getActiveLlmProvider: () => ({
    id: 'anthropic',
    getApiKeyStatus: () => ({ isConfigured: true }),
  }),
}))

import llm from './llm'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createApp() {
  const app = new Hono()
  app.route('/api/llm', llm)
  return app
}

async function post(app: ReturnType<typeof createApp>, path: string, body: unknown) {
  const req = new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return app.fetch(req)
}

async function get(app: ReturnType<typeof createApp>, path: string) {
  return app.fetch(new Request(`http://localhost${path}`))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LLM proxy endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('GET /api/llm/config', () => {
    it('returns provider config', async () => {
      const app = createApp()
      const res = await get(app, '/api/llm/config')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.configured).toBe(true)
      expect(body.defaultModel).toBe('claude-sonnet-4-6')
      expect(body.provider).toBe('anthropic')
    })
  })

  describe('POST /api/llm/v1/messages', () => {
    it('forwards request to SDK and returns response', async () => {
      const mockResponse = {
        id: 'msg_123',
        type: 'message',
        content: [{ type: 'text', text: 'Hello!' }],
      }
      mockCreate.mockResolvedValue(mockResponse)

      const app = createApp()
      const res = await post(app, '/api/llm/v1/messages', {
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 100,
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.content[0].text).toBe('Hello!')
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'claude-sonnet-4-6',
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 100,
        }),
      )
    })

    it('uses specified model over default', async () => {
      mockCreate.mockResolvedValue({ content: [] })

      const app = createApp()
      await post(app, '/api/llm/v1/messages', {
        model: 'claude-opus-4-7',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 10,
      })

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'claude-opus-4-7' }),
      )
    })

    it('returns 400 for missing messages', async () => {
      const app = createApp()
      const res = await post(app, '/api/llm/v1/messages', { max_tokens: 10 })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain('messages')
    })

    it('returns 400 for invalid JSON', async () => {
      const app = createApp()
      const req = new Request('http://localhost/api/llm/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      })
      const res = await app.fetch(req)
      expect(res.status).toBe(400)
    })

    it('strips auth-related fields from body', async () => {
      mockCreate.mockResolvedValue({ content: [] })

      const app = createApp()
      await post(app, '/api/llm/v1/messages', {
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 10,
        apiKey: 'stolen-key',
        baseURL: 'https://evil.com',
        api_key: 'also-stolen',
        base_url: 'https://also-evil.com',
      })

      const calledWith = mockCreate.mock.calls[0][0]
      expect(calledWith.apiKey).toBeUndefined()
      expect(calledWith.baseURL).toBeUndefined()
      expect(calledWith.api_key).toBeUndefined()
      expect(calledWith.base_url).toBeUndefined()
    })

    it('returns streaming SSE response when stream: true', async () => {
      const mockEvents = [
        { type: 'message_start', message: { id: 'msg_1' } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } },
        { type: 'message_stop' },
      ]
      mockCreate.mockResolvedValue({
        [Symbol.asyncIterator]: async function* () {
          for (const event of mockEvents) yield event
        },
      })

      const app = createApp()
      const res = await post(app, '/api/llm/v1/messages', {
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 100,
        stream: true,
      })

      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('text/event-stream')

      const text = await res.text()
      expect(text).toContain('event: message_start')
      expect(text).toContain('event: content_block_delta')
      expect(text).toContain('event: message_stop')
      expect(text).toContain('"text":"Hi"')
    })

    it('passes through SDK errors with status code', async () => {
      const sdkError = new Error('Rate limit exceeded')
      ;(sdkError as any).status = 429
      mockCreate.mockRejectedValue(sdkError)

      const app = createApp()
      const res = await post(app, '/api/llm/v1/messages', {
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 10,
      })

      expect(res.status).toBe(429)
      const body = await res.json()
      expect(body.error).toContain('Rate limit')
    })
  })
})
