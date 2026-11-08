import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'

const state = vi.hoisted(() => ({
  admin: true,
  authMode: false,
  startOllamaPull: vi.fn(async () => {}),
  cancelOllamaPull: vi.fn(async () => {}),
  syncCatalogsFromStatus: vi.fn(async () => {}),
  getOllamaStatus: vi.fn(),
}))
vi.mock('../middleware/auth', () => ({
  IsAdmin: () => async (c: { json: (body: unknown, status: number) => Response }, next: () => Promise<void>) => (
    state.admin ? next() : c.json({ error: 'Admin required' }, 403)
  ),
}))
vi.mock('@shared/lib/auth/mode', () => ({ isAuthMode: () => state.authMode }))
vi.mock('@shared/lib/llm-provider/ollama-pull', () => ({
  startOllamaPull: state.startOllamaPull,
  cancelOllamaPull: state.cancelOllamaPull,
  listOllamaPulls: async () => [],
}))
vi.mock('@shared/lib/llm-provider/ollama-catalog-sync', () => ({ syncCatalogsFromStatus: state.syncCatalogsFromStatus }))
vi.mock('@shared/lib/llm-provider/ollama-client', () => ({ getOllamaStatus: state.getOllamaStatus }))

import { backgroundSettled } from '@shared/lib/background'
import routes from './ollama'

const app = new Hono().route('/', routes)
const post = (path: string, body: unknown) => app.request(path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

beforeEach(() => {
  state.admin = true
  state.authMode = false
  vi.clearAllMocks()
})

describe('Ollama routes', () => {
  it('lets only an admin write to the server\'s disk', async () => {
    state.admin = false
    expect((await post('/pulls', { model: 'm:latest' })).status).toBe(403)
    expect((await post('/pulls/cancel', { model: 'm:latest' })).status).toBe(403)
    expect(state.startOllamaPull).not.toHaveBeenCalled()
    expect(state.cancelOllamaPull).not.toHaveBeenCalled()
  })

  it('starts a pull on the normalized address', async () => {
    expect((await post('/pulls', { baseUrl: 'localhost:9000/', model: 'm:latest' })).status).toBe(202)
    expect(state.startOllamaPull).toHaveBeenCalledWith('http://localhost:9000', 'm:latest')
  })

  it('refuses a model name that is not one', async () => {
    const response = await post('/pulls', { model: '--insecure; rm' })
    expect(response.status).toBe(400)
    expect(state.startOllamaPull).not.toHaveBeenCalled()
  })

  it('says what is wrong with an address', async () => {
    const response = await post('/status', { baseUrl: 'http://my-mac:11434' })
    expect(response.status).toBe(400)
    expect((await response.json() as { error: string }).error).toContain('my-mac')
  })

  it('syncs catalogs from a server that answered, and only then', async () => {
    const models = [{ id: 'm:latest' }]
    state.getOllamaStatus.mockResolvedValueOnce({ state: 'running', baseUrl: 'http://localhost:11434', models })
    await post('/status', {})
    await backgroundSettled()
    expect(state.syncCatalogsFromStatus).toHaveBeenCalledWith('http://localhost:11434', models)

    state.syncCatalogsFromStatus.mockClear()
    state.getOllamaStatus.mockResolvedValueOnce({ state: 'not-found', baseUrl: 'http://localhost:11434', error: 'x' })
    await post('/status', {})
    await backgroundSettled()
    expect(state.syncCatalogsFromStatus).not.toHaveBeenCalled()
  })

  it('answers without waiting for the catalogs to be written', async () => {
    state.getOllamaStatus.mockResolvedValueOnce({ state: 'running', baseUrl: 'http://localhost:11434', models: [] })
    let finish!: () => void
    state.syncCatalogsFromStatus.mockReturnValueOnce(new Promise<void>(resolve => { finish = resolve }))
    expect((await post('/status', {})).status).toBe(200)
    finish()
    await backgroundSettled()
  })

  it('tells a non-admin only that Ollama did not answer, not why', async () => {
    state.authMode = true
    state.getOllamaStatus.mockResolvedValue({ state: 'unreachable', baseUrl: 'http://10.0.0.5:8080', error: 'http://10.0.0.5:8080/api/version returned 404' })
    const body = await (await post('/status', { baseUrl: 'http://10.0.0.5:8080' })).json() as { error: string }
    expect(body.error).toBe('Could not reach Ollama at http://10.0.0.5:8080')
  })
})
