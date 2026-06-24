import { describe, it, expect, vi, beforeEach } from 'vitest'

const validateProxyToken = vi.fn(async (_token: string): Promise<string | null> => null)
vi.mock('@shared/lib/proxy/token-store', () => ({
  validateProxyToken: (t: string) => validateProxyToken(t),
}))

import agentBootstrap from './agent-bootstrap'
import { setBootstrapEnv, resetBootstrapEnvStoreForTests } from '@shared/lib/container/agent-bootstrap-env-store'

function get(path: string, headers: Record<string, string> = {}) {
  return agentBootstrap.request(path, { headers })
}

beforeEach(() => {
  validateProxyToken.mockReset().mockResolvedValue(null)
  resetBootstrapEnvStoreForTests()
})

describe('GET /:agentSlug/env', () => {
  it('returns the stashed env for a valid token matching the agent', async () => {
    validateProxyToken.mockResolvedValue('agent-1')
    setBootstrapEnv('agent-1', { FOO: 'bar', PROXY_TOKEN: 'synth_x' })
    const res = await get('/agent-1/env', { Authorization: 'Bearer synth_x' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ env: { FOO: 'bar', PROXY_TOKEN: 'synth_x' } })
  })

  it('401 when the Authorization header is missing', async () => {
    setBootstrapEnv('agent-1', { FOO: 'bar' })
    expect((await get('/agent-1/env')).status).toBe(401)
  })

  it('401 when the token is invalid', async () => {
    validateProxyToken.mockResolvedValue(null)
    setBootstrapEnv('agent-1', { FOO: 'bar' })
    expect((await get('/agent-1/env', { Authorization: 'Bearer nope' })).status).toBe(401)
  })

  it('403 when the token resolves to a different agent', async () => {
    validateProxyToken.mockResolvedValue('agent-2')
    setBootstrapEnv('agent-1', { FOO: 'bar' })
    expect((await get('/agent-1/env', { Authorization: 'Bearer synth_other' })).status).toBe(403)
  })

  it('404 when no env is stashed', async () => {
    validateProxyToken.mockResolvedValue('agent-1')
    expect((await get('/agent-1/env', { Authorization: 'Bearer synth_x' })).status).toBe(404)
  })

  it('is single-use: the second fetch gets 404', async () => {
    validateProxyToken.mockResolvedValue('agent-1')
    setBootstrapEnv('agent-1', { FOO: 'bar' })
    expect((await get('/agent-1/env', { Authorization: 'Bearer synth_x' })).status).toBe(200)
    expect((await get('/agent-1/env', { Authorization: 'Bearer synth_x' })).status).toBe(404)
  })
})
