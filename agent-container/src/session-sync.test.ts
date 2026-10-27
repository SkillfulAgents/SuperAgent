import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { syncSavedSession } from './session-sync'

const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })

beforeEach(() => {
  vi.stubEnv('HOST_APP_URL', 'http://host.docker.internal:47891')
  vi.stubEnv('PROXY_TOKEN', 'proxy-token')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('syncSavedSession', () => {
  it('asks the host, as this agent, about the page it opened', async () => {
    const fetchImpl = vi.fn(async () => answer(200, { restored: true }))
    expect(await syncSavedSession('s-1', 'https://github.com/dashboard', fetchImpl)).toBe(true)
    expect(fetchImpl).toHaveBeenCalledWith('http://host.docker.internal:47891/api/browser/session-sync', expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer proxy-token' },
      body: JSON.stringify({ sessionId: 's-1', url: 'https://github.com/dashboard' }),
    }))
  })

  it('leaves the page as it is when the host says nothing went in, refuses, or cannot be reached', async () => {
    expect(await syncSavedSession('s-1', 'https://github.com/', vi.fn(async () => answer(200, { restored: false })))).toBe(false)
    expect(await syncSavedSession('s-1', 'https://github.com/', vi.fn(async () => answer(401, { error: 'Unauthorized' })))).toBe(false)
    expect(await syncSavedSession('s-1', 'https://github.com/', vi.fn(async () => { throw new Error('ECONNREFUSED') }))).toBe(false)
  })

  it('asks nothing for a page that is not on the web, or with no host to ask', async () => {
    const fetchImpl = vi.fn(async () => answer(200, { restored: true }))
    expect(await syncSavedSession('s-1', 'chrome-error://chromewebdata/', fetchImpl)).toBe(false)
    vi.stubEnv('HOST_APP_URL', '')
    expect(await syncSavedSession('s-1', 'https://github.com/', fetchImpl)).toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
