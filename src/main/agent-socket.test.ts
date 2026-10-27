import { EventEmitter } from 'events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const resolve = vi.fn()
const webSocketTarget = vi.fn()

vi.mock('@shared/lib/agent-actor', () => ({
  agentCatalog: { resolve: (id: string) => resolve(id) },
  agentRegistry: { get: () => ({ container: { webSocketTarget: (...args: unknown[]) => webSocketTarget(...args) } }) },
}))
vi.mock('@shared/lib/auth/mode', () => ({ isAuthMode: () => false }))
vi.mock('@shared/lib/error-reporting', () => ({ captureException: vi.fn() }))

import type { AgentSocketRequest } from './agent-socket'
import { handleAgentSocket } from './agent-socket'
import { setWebSocketOpener } from './websocket-opener'

function request(path: string, headers: Record<string, string> = {}): AgentSocketRequest {
  return { url: new URL(`https://acme.example${path}`), headers: new Headers({ host: 'acme.example', ...headers }) }
}

class FakeUpstream extends EventEmitter {
  protocol = ''
  terminate = vi.fn()
}

describe('handleAgentSocket', () => {
  beforeEach(() => {
    resolve.mockImplementation(async (id: string) => (id === 'research-a1' ? 'a1' : null))
    webSocketTarget.mockResolvedValue({ url: 'ws://container/artifacts/slides/', headers: { authorization: 'Bearer host' } })
  })
  afterEach(() => vi.clearAllMocks())

  it('leaves paths that are not agent sockets alone', () => {
    expect(handleAgentSocket(request('/api/agents/research-a1/sessions'))).toBeNull()
    expect(handleAgentSocket(request('/cloud/key/api/events'))).toBeNull()
  })

  it('refuses an unknown agent with 404', async () => {
    expect(await handleAgentSocket(request('/api/agents/missing/browser/stream'))).toEqual({ kind: 'refuse', status: 404 })
  })

  it('opens a dashboard socket through the deployment opener and answers with its subprotocol', async () => {
    const upstream = new FakeUpstream()
    const opener = vi.fn(() => {
      setTimeout(() => {
        upstream.protocol = 'vite-hmr'
        upstream.emit('open')
      })
      return upstream as any
    })
    setWebSocketOpener(opener)

    const decision = await handleAgentSocket(request('/api/agents/research-a1/artifacts/slides/', {
      'sec-websocket-protocol': 'vite-hmr',
    }))

    expect(opener).toHaveBeenCalledWith({ url: 'ws://container/artifacts/slides/', headers: { authorization: 'Bearer host' } })
    expect(webSocketTarget.mock.calls[0][1]).toMatchObject({ protocols: ['vite-hmr'] })
    expect(decision).toMatchObject({ kind: 'accept', protocol: 'vite-hmr' })
  })

  it('refuses with 502 when the dashboard refuses its upgrade', async () => {
    const upstream = new FakeUpstream()
    setWebSocketOpener(() => {
      setTimeout(() => upstream.emit('error', new Error('connection refused')))
      return upstream as any
    })

    expect(await handleAgentSocket(request('/api/agents/research-a1/artifacts/slides/'))).toEqual({ kind: 'refuse', status: 502 })
    expect(upstream.terminate).toHaveBeenCalled()
  })
})
