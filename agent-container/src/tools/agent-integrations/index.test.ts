import { afterEach, describe, expect, it, vi } from 'vitest'
import { integrationTools } from './index'
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })
describe('integration MCP tools', () => {
  it('uses the live SDK session getter and exposes no model-controlled destination', async () => {
    vi.stubEnv('SUPERAGENT_HOST_API_URL', 'http://host/api')
    vi.stubEnv('PROXY_TOKEN', 'agent-token')
    const fetchMock = vi.fn(async () => Response.json({ result: true }))
    vi.stubGlobal('fetch', fetchMock)
    let sessionId = 'initial'
    const tools = integrationTools(() => sessionId)
    sessionId = 'canonical-sdk-id'
    const execute = tools.find(tool => tool.name === 'execute_integration_tool')!
    await execute.handler({ name: 'update_task', input: { title: 'Changed' } }, {} as never)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({ sessionId: 'canonical-sdk-id', name: 'update_task', input: { title: 'Changed' } })
    expect(fetchMock.mock.calls[0][0]).toBe('http://host/api/x-agent/integration-tools/execute')
  })
})
