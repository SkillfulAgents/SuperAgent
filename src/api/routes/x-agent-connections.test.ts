import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import type { ConnectionService } from '@shared/lib/connection-catalog/catalog'

const validateProxyToken = vi.fn<(token: string) => Promise<string | null>>()
vi.mock('@shared/lib/proxy/token-store', () => ({ validateProxyToken: (token: string) => validateProxyToken(token) }))
const agentConnectionCatalog = vi.fn<(slug: string) => Promise<ConnectionService[]>>()
vi.mock('@shared/lib/connection-catalog/agent-catalog', () => ({ agentConnectionCatalog: (slug: string) => agentConnectionCatalog(slug) }))

import xAgentConnections from './x-agent-connections'

const service = (slug: string, category: string): ConnectionService => ({
  service: slug, displayName: slug, category, accounts: [], mcps: [], integrations: [],
})

const app = new Hono().route('/api/x-agent/connections', xAgentConnections)
const post = (body: unknown, token = 'token') => app.request('/api/x-agent/connections/search', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify(body),
})

describe('POST /api/x-agent/connections/search', () => {
  beforeEach(() => {
    validateProxyToken.mockReset().mockResolvedValue('agent-one')
    agentConnectionCatalog.mockReset().mockResolvedValue([service('slack', 'Communication'), service('figma', 'Design'), service('discord', 'Communication')])
  })

  it('searches the caller\'s own catalog', async () => {
    const response = await post({ search: 'slack' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ total: 3, services: [service('slack', 'Communication')] })
    expect(agentConnectionCatalog).toHaveBeenCalledWith('agent-one')
  })

  it('answers a blank term with the category index', async () => {
    expect(await (await post({ search: '  ' })).json()).toEqual({
      total: 3,
      index: [{ category: 'Communication', services: 2 }, { category: 'Design', services: 1 }],
    })
  })

  it('refuses a caller without an agent token and a term that is not a string', async () => {
    validateProxyToken.mockResolvedValueOnce(null)
    expect((await post({ search: 'slack' }, 'bad')).status).toBe(401)
    expect((await post({ search: 7 })).status).toBe(400)
    expect(agentConnectionCatalog).not.toHaveBeenCalled()
  })
})
