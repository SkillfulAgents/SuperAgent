/**
 * ELECTRON-DD — recurring 401 from a running local agent.
 *
 * A container keeps requiring the host token it was *started* with. When the
 * host's token store is lost or rewritten while that container keeps running
 * (data-dir wipe, unreadable token file — host-token-store regenerates in that
 * case), every policy-bearing request 401s forever: the agent is wedged and
 * `createSession` reported it as an opaque "Failed to create session".
 *
 * Recovery must be evidence-based and bounded: restart + retry exactly once,
 * and only when the container proves it is holding a *different* token
 * generation. A current-generation 401 stays a typed error so it cannot loop.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import http from 'http'
import type { AddressInfo } from 'net'
import { hostTokenId } from './host-token-store'

let currentHostToken = 'hostc_current'
vi.mock('./host-token-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./host-token-store')>()
  return { ...actual, getOrCreateHostToken: () => currentHostToken }
})

const breadcrumbs: { message: string; data?: Record<string, unknown> }[] = []
vi.mock('@shared/lib/error-reporting', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  addErrorBreadcrumb: (crumb: { message: string; data?: Record<string, unknown> }) => {
    breadcrumbs.push(crumb)
  },
}))

vi.mock('@shared/lib/config/settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@shared/lib/config/settings')>()),
  getSettings: () => ({ container: {}, enableToolSearch: true, llmProvider: 'anthropic' }),
  getAgentCapabilitySettings: () => ({}),
}))
vi.mock('@shared/lib/llm-provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@shared/lib/llm-provider')>()),
  getActiveLlmProvider: () => ({ id: 'anthropic', getContainerEnvVars: () => ({}) }),
}))

const { BaseContainerClient, ContainerUnauthorizedError } = await import('./base-container-client')
type ContainerInfo = import('./types').ContainerInfo
type ContainerConfig = import('./types').ContainerConfig

/** Stands in for the agent container: /health is open, /sessions needs the token. */
class FakeContainer {
  readonly server: http.Server
  sessionAttempts = 0
  constructor(public acceptedToken: string, public reportTokenId: boolean = true) {
    this.server = http.createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          status: 'ok',
          ...(this.reportTokenId ? { hostTokenId: hostTokenId(this.acceptedToken) } : {}),
        }))
        return
      }
      if (req.url === '/sessions' && req.method === 'POST') {
        this.sessionAttempts++
        req.resume()
        if (req.headers['x-superagent-host-token'] !== this.acceptedToken) {
          res.writeHead(401, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'Unauthorized' }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ id: 'session-1', status: 'active' }))
        return
      }
      res.writeHead(404)
      res.end()
    })
  }
  async listen(): Promise<number> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    return (this.server.address() as AddressInfo).port
  }
  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }
}

function makeClient(port: number, restartAgent?: () => Promise<void>) {
  class TestClient extends BaseContainerClient {
    protected getRunnerCommand(): string {
      return 'docker'
    }
    async getInfoFromRuntime(): Promise<ContainerInfo> {
      return { status: 'running', port }
    }
  }
  return new TestClient({ agentId: 'agent-1', restartAgent } as ContainerConfig)
}

describe('createSession host-auth recovery (ELECTRON-DD)', () => {
  let container: FakeContainer
  let port: number

  beforeEach(() => {
    breadcrumbs.length = 0
    currentHostToken = 'hostc_current'
  })

  afterEach(async () => {
    await container?.close()
  })

  it('restarts the container once and retries once when it holds a superseded token', async () => {
    // Container was started with the *old* token; the host store now holds a new one.
    container = new FakeContainer('hostc_stale')
    port = await container.listen()
    const restartAgent = vi.fn(async () => {
      // A real restart boots the container with the host's current token.
      container.acceptedToken = currentHostToken
    })

    const session = await makeClient(port, restartAgent).createSession({ initialMessage: 'hi' })

    expect(session).toMatchObject({ id: 'session-1' })
    expect(restartAgent).toHaveBeenCalledTimes(1)
    expect(container.sessionAttempts).toBe(2) // original + exactly one retry
  })

  it('keeps a current-generation 401 typed and does not restart', async () => {
    // Same generation on both sides, yet the container refuses: a real
    // authorization failure, not a stale container.
    container = new FakeContainer(currentHostToken)
    port = await container.listen()
    container.acceptedToken = currentHostToken
    const restartAgent = vi.fn(async () => {})
    // Force a 401 while still reporting the *current* token id.
    const client = makeClient(port, restartAgent)
    container.acceptedToken = currentHostToken
    vi.spyOn(client, 'getHostAuthHeaders').mockReturnValue({ 'x-superagent-host-token': 'wrong' })

    await expect(client.createSession({ initialMessage: 'hi' }))
      .rejects.toBeInstanceOf(ContainerUnauthorizedError)

    expect(restartAgent).not.toHaveBeenCalled()
    expect(container.sessionAttempts).toBe(1)
  })

  it('retries at most once — a second 401 propagates as the typed error', async () => {
    container = new FakeContainer('hostc_stale')
    port = await container.listen()
    // A restart that does not fix the token (e.g. the store rotated again).
    const restartAgent = vi.fn(async () => {
      container.acceptedToken = 'hostc_still_stale'
    })

    await expect(makeClient(port, restartAgent).createSession({ initialMessage: 'hi' }))
      .rejects.toBeInstanceOf(ContainerUnauthorizedError)

    expect(restartAgent).toHaveBeenCalledTimes(1)
    expect(container.sessionAttempts).toBe(2)
  })

  it('does not restart a container that cannot report its token id (older image)', async () => {
    container = new FakeContainer('hostc_stale', /* reportTokenId */ false)
    port = await container.listen()
    const restartAgent = vi.fn(async () => {})

    await expect(makeClient(port, restartAgent).createSession({ initialMessage: 'hi' }))
      .rejects.toBeInstanceOf(ContainerUnauthorizedError)

    expect(restartAgent).not.toHaveBeenCalled()
    expect(container.sessionAttempts).toBe(1)
  })

  it('never records token material — only one-way ids', async () => {
    container = new FakeContainer('hostc_stale')
    port = await container.listen()
    const restartAgent = vi.fn(async () => {
      container.acceptedToken = currentHostToken
    })

    await makeClient(port, restartAgent).createSession({ initialMessage: 'hi' })

    const authCrumbs = breadcrumbs.filter((c) => /host token/i.test(c.message))
    expect(authCrumbs.length).toBeGreaterThan(0)
    const serialized = JSON.stringify(authCrumbs)
    expect(serialized).not.toContain('hostc_')
    expect(serialized).toContain(hostTokenId('hostc_stale'))
  })
})

describe('hostTokenId', () => {
  it('is stable, short and reveals no token material', () => {
    const token = 'hostc_0123456789abcdef'
    const id = hostTokenId(token)
    expect(id).toBe(hostTokenId(token))
    expect(id).toHaveLength(16)
    expect(id).toMatch(/^[0-9a-f]+$/)
    expect(token).not.toContain(id)
    expect(hostTokenId('hostc_other')).not.toBe(id)
  })
})
