import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { getRequestListener } from '@hono/node-server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  providerName: 'openai' as string | undefined, alternateEnabled: false, user: 'alice', authenticated: true,
  create: vi.fn(), map: vi.fn(), close: vi.fn(async () => {}),
  alternateCreate: vi.fn(), alternateMap: vi.fn(), alternateClose: vi.fn(async () => {}),
}))
vi.mock('../middleware/auth', () => ({ Authenticated: () => async (_c: unknown, next: () => Promise<void>) => mocks.authenticated ? next() : new Response('Unauthorized', { status: 401 }) }))
vi.mock('@shared/lib/config/settings', () => ({ getVoiceSettings: () => ({ sttProvider: mocks.providerName }) }))
vi.mock('@shared/lib/voice', () => ({
  getVoiceProvider: (id: string) => ({
    name: { openai: 'OpenAI', deepgram: 'Deepgram', platform: 'Platform' }[id],
    getLiveConversation: () => id === 'openai'
      ? { createLiveSession: mocks.create, mapLiveConversation: mocks.map, closeLiveSession: mocks.close }
      : mocks.alternateEnabled
        ? { createLiveSession: mocks.alternateCreate, mapLiveConversation: mocks.alternateMap, closeLiveSession: mocks.alternateClose }
        : null,
    getApiKeyStatus: () => ({ isConfigured: true }), supportsTts: () => false, supportsVoiceAgent: () => true, getConversationEngine: () => 'openai-live',
  }),
}))
vi.mock('@shared/lib/auth/config', () => ({ getCurrentUserId: () => mocks.user }))
vi.mock('@shared/lib/services/user-settings-service', () => ({ getUserSettings: () => ({}) }))
import voice from './voice'

function request(path: string, body: unknown) {
  return voice.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
}
// Match Vite's real Node adapter: native globals, adapter-owned Request objects.
async function chunkedRequest(path: string, chunks: Buffer[]) {
  const server = createServer(getRequestListener(voice.fetch, { overrideGlobalObjects: false }))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing test server port')
  try {
    return await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest({ hostname: '127.0.0.1', port: address.port, path, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' },
      }, (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => { body += chunk })
        res.on('end', () => resolve({ status: res.statusCode!, body }))
        res.on('error', reject)
      })
      req.on('error', reject)
      for (const chunk of chunks) req.write(chunk)
      req.end()
    })
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve())
      server.closeAllConnections()
    })
  }
}

beforeEach(() => {
  vi.clearAllMocks(); mocks.providerName = 'openai'; mocks.user = 'alice'; mocks.authenticated = true; mocks.alternateEnabled = false
  mocks.create.mockResolvedValue({ session: { id: 'live_test' }, transport: { type: 'webrtc', sdp: 'answer' } })
})

describe('Live voice routes', () => {
  it('advertises Live separately from unsupported standalone TTS', async () => {
    expect(await (await voice.request('/configured')).json()).toMatchObject({ conversationEngine: 'openai-live', supportsTts: false })
  })
  it('requires authentication before calling a provider', async () => {
    mocks.authenticated = false
    expect((await request('/live/session', { sdp: 'offer', history: [] })).status).toBe(401)
    expect((await request('/live/map', { kind: 'reply', text: 'Working...' })).status).toBe(401)
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.map).not.toHaveBeenCalled()
  })
  it.each([['deepgram', 'Deepgram'], ['platform', 'Platform']])('reports unsupported operations for %s', async (id, name) => {
    mocks.providerName = id
    const creation = await request('/live/session', { sdp: 'offer', history: [] })
    expect(creation.status).toBe(400)
    expect(await creation.json()).toEqual({ error: `Live session creation not supported with current configured voice provider: ${name}` })
    const mapping = await request('/live/map', { kind: 'reply', text: 'Working...' })
    expect(mapping.status).toBe(400)
    expect(await mapping.json()).toEqual({ error: `Live conversation mapping not supported with current configured voice provider: ${name}` })
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.map).not.toHaveBeenCalled()
  })
  it('reports missing configuration without selecting a fallback provider', async () => {
    mocks.providerName = undefined
    for (const [path, body] of [
      ['/live/session', { sdp: 'offer', history: [] }],
      ['/live/map', { kind: 'reply', text: 'Working...' }],
    ] as const) {
      const response = await request(path, body)
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: 'No voice provider configured. Set one in Settings > Voice.' })
    }
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.map).not.toHaveBeenCalled()
  })
  it('dispatches by capability and keeps cleanup bound to the creating provider', async () => {
    // A future provider can implement this capability without changing routes.
    mocks.providerName = 'deepgram'
    mocks.alternateEnabled = true
    mocks.alternateCreate.mockResolvedValue({ session: { id: 'other_session' }, transport: { type: 'webrtc', sdp: 'other-answer' } })
    mocks.alternateMap.mockResolvedValue({ text: 'Other provider reply' })
    const creation = await request('/live/session', { sdp: 'offer', history: [] })
    expect(creation.status).toBe(201)
    const { handle, transport } = await creation.json()
    expect(transport.sdp).toBe('other-answer')
    expect(mocks.alternateCreate).toHaveBeenCalledExactlyOnceWith('offer', [])
    const mapping = await request('/live/map', { kind: 'reply', text: 'Working...' })
    expect(await mapping.json()).toEqual({ text: 'Other provider reply' })
    expect(mocks.alternateMap).toHaveBeenCalledExactlyOnceWith({ kind: 'reply', text: 'Working...' }, expect.any(AbortSignal))
    mocks.providerName = 'openai'
    expect((await voice.request(`/live/session/${handle}`, { method: 'DELETE' })).status).toBe(200)
    expect(mocks.alternateClose).toHaveBeenCalledExactlyOnceWith('other_session')
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.map).not.toHaveBeenCalled()
    expect(mocks.close).not.toHaveBeenCalled()
  })
  it('rejects invalid and oversized mappings before calling the LLM', async () => {
    expect((await request('/live/map', { kind: 'request', transcript: '' })).status).toBe(400)
    expect((await request('/live/map', { kind: 'reply', text: 'a'.repeat(140000) })).status).toBe(413)
    expect(mocks.map).not.toHaveBeenCalled()
  })
  it('binds cleanup to the initiating user and permits cleanup after switching providers', async () => {
    const response = await request('/live/session', { sdp: 'offer', history: [] })
    expect(response.status).toBe(201)
    const { handle } = await response.json()
    mocks.user = 'bob'
    expect((await voice.request(`/live/session/${handle}`, { method: 'DELETE' })).status).toBe(404)
    expect(mocks.close).not.toHaveBeenCalled()
    mocks.user = 'alice'; mocks.providerName = 'deepgram'
    expect((await voice.request(`/live/session/${handle}`, { method: 'DELETE' })).status).toBe(200)
    expect(mocks.close).toHaveBeenCalledExactlyOnceWith('live_test')
  })
  it('releases admission slots while a failed upstream hangup is retried', async () => {
    vi.useFakeTimers()
    mocks.user = 'cleanup-retry-owner'
    mocks.close.mockRejectedValue(new Error('Temporary upstream failure'))
    try {
      const handles: string[] = []
      for (let i = 0; i < 4; i++) {
        const response = await request('/live/session', { sdp: 'offer', history: [] })
        expect(response.status).toBe(201)
        const body = await response.json()
        expect(body.expiresAt).toBeGreaterThan(Date.now())
        handles.push(body.handle)
      }
      expect((await request('/live/session', { sdp: 'offer', history: [] })).status).toBe(429)
      for (const handle of handles) {
        expect((await voice.request(`/live/session/${handle}`, { method: 'DELETE' })).status).toBe(202)
      }
      const replacement = await request('/live/session', { sdp: 'offer', history: [] })
      expect(replacement.status).toBe(201)
      const { handle } = await replacement.json()
      mocks.close.mockResolvedValue(undefined)
      await vi.advanceTimersByTimeAsync(1000)
      expect(mocks.close).toHaveBeenCalledTimes(8)
      expect((await voice.request(`/live/session/${handle}`, { method: 'DELETE' })).status).toBe(200)
    } finally {
      mocks.close.mockResolvedValue(undefined)
      vi.useRealTimers()
    }
  })
  it('returns a mapping error without disclosing provider details', async () => {
    mocks.map.mockRejectedValueOnce(new Error('secret upstream info'))
    const response = await request('/live/map', { kind: 'reply', text: 'Working...' })
    expect(response.status).toBe(502)
    expect(await response.text()).not.toContain('secret')
  })
  it('validates invalid chunked JSON through the development HTTP adapter', async () => {
    const response = await chunkedRequest('/live/map', [Buffer.from('{}')])
    expect(response.status).toBe(400)
    expect(mocks.map).not.toHaveBeenCalled()
  })
  it('maps chunked JSON with a UTF-8 character split across writes', async () => {
    const text = 'Hello 🌍'
    const bytes = Buffer.from(JSON.stringify({ kind: 'reply', text }))
    const split = bytes.indexOf(Buffer.from('🌍')) + 2
    mocks.map.mockResolvedValueOnce({ text: 'Hello world' })
    const response = await chunkedRequest('/live/map', [bytes.subarray(0, split), bytes.subarray(split)])
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toEqual({ text: 'Hello world' })
    expect(mocks.map).toHaveBeenCalledExactlyOnceWith({ kind: 'reply', text }, expect.any(AbortSignal))
  })
  it('rejects oversized chunked bodies before mapping', async () => {
    const response = await chunkedRequest('/live/map', [Buffer.alloc(64 * 1024, 'x'), Buffer.alloc(64 * 1024 + 1, 'x')])
    expect(response.status).toBe(413)
    expect(mocks.map).not.toHaveBeenCalled()
  })

  it('accepts exactly the byte limit and counts multibyte input by bytes', async () => {
    const json = Buffer.from(JSON.stringify({ kind: 'reply', text: 'Hello' }))
    mocks.map.mockResolvedValueOnce({ text: 'Hello' })
    const exact = await chunkedRequest('/live/map', [json, Buffer.alloc(128 * 1024 - json.length, ' ')])
    expect(exact.status).toBe(200)
    mocks.map.mockClear()
    const oversized = await chunkedRequest('/live/map', [Buffer.from('界'.repeat(45000))])
    expect(oversized.status).toBe(413)
    expect(mocks.map).not.toHaveBeenCalled()
  })

})
