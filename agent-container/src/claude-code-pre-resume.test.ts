/**
 * ClaudeCodeProcess.warm() — the pre-resume the host asks for when a person
 * starts typing into a session whose CLI was evicted. It must run the same
 * restart a cold send runs, without queueing a message, and it must never let
 * a send that races it restart the process a second time.
 *
 * `calls` counts SDK query() creations: one per CLI (re)start.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type MockMcpStatus = { name: string; status: string }
const calls: Array<{ options: Record<string, unknown> }> = []
// Left null, every server on the latest query reports connected at once.
let mcpServerStatusImpl: (() => Promise<MockMcpStatus[]>) | null = null

vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  // A live CLI: the message stream stays open until the query is aborted or
  // returned. It ignores its input queue, so a graceful stop runs out its
  // grace window and then aborts, as with a CLI that keeps running.
  function makeQuery(args: { options: Record<string, unknown> }) {
    const abortController = args.options.abortController as AbortController
    let resolvePending: ((result: IteratorResult<never>) => void) | undefined
    const finish = () => {
      resolvePending?.({ value: undefined, done: true })
      resolvePending = undefined
    }
    abortController.signal.addEventListener('abort', finish, { once: true })
    return {
      [Symbol.asyncIterator]() {
        return this
      },
      next() {
        if (abortController.signal.aborted) return Promise.resolve({ value: undefined, done: true })
        return new Promise<IteratorResult<never>>((resolve) => {
          resolvePending = resolve
        })
      },
      return() {
        finish()
        return Promise.resolve({ value: undefined, done: true })
      },
      throw(error?: unknown) {
        return Promise.reject(error)
      },
      interrupt: () => Promise.resolve(),
      setModel: () => Promise.resolve(),
      mcpServerStatus: () => {
        if (mcpServerStatusImpl) return mcpServerStatusImpl()
        const servers = (calls[calls.length - 1]?.options.mcpServers ?? {}) as Record<string, unknown>
        return Promise.resolve(Object.keys(servers).map((name) => ({ name, status: 'connected' })))
      },
    }
  }
  return {
    query: vi.fn((args: { options: Record<string, unknown> }) => {
      calls.push({ options: args.options })
      return makeQuery(args)
    }),
  }
})

vi.mock('./mcp-server', () => ({
  createUserInputMcpServer: () => ({}),
  createBrowserMcpServer: () => ({}),
  createComputerUseMcpServer: () => ({}),
  createDashboardsMcpServer: () => ({}),
  createWidgetsMcpServer: () => ({}),
  createAgentsMcpServer: () => ({}),
  createChatMcpServer: () => ({}),
  createMeetingsMcpServer: () => ({}),
}))
vi.mock('./tools/browser', () => ({ createBrowserTools: () => [] }))
vi.mock('./tools/computer-use', () => ({ computerUseTools: [] }))
vi.mock('./file-hooks', () => ({ fileHooks: {}, resolveToolFilePath: () => '' }))
vi.mock('./input-manager', () => ({ inputManager: {}, HUMAN_INPUT_TTL_MS: 24 * 60 * 60 * 1000 }))

import { ClaudeCodeProcess } from './claude-code'
import type { ConnectionRuntime } from './connection-runtime'

const CALENDAR = JSON.stringify([
  {
    id: 'mcp-calendar',
    name: 'Team Calendar',
    proxyUrl: 'http://host.test/api/mcp-proxy/test-agent/mcp-calendar',
    tools: [{ name: 'list_events' }],
  },
])

function runtime(overrides: Partial<ConnectionRuntime> = {}): ConnectionRuntime {
  return {
    llmProviderId: 'anthropic', generation: 0, provider: 'anthropic', model: 'claude-model',
    browserModel: 'claude-model', dashboardBuilderModel: 'claude-model', modelPromptHints: [],
    subagentModels: [], modelContextWindows: {}, env: { ANTHROPIC_API_KEY: 'session-key' },
    ...overrides,
  }
}

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

/** A session whose CLI ran, then went idle and was evicted (graceful stop). */
async function evictedProcess(sessionId: string): Promise<ClaudeCodeProcess> {
  const proc = new ClaudeCodeProcess({ sessionId, claudeSessionId: `cli-${sessionId}`, workingDirectory: '/tmp' })
  await proc.start()
  await proc.stop({ graceful: true, graceMs: 10 })
  expect(proc.isRunning()).toBe(false)
  return proc
}

describe('ClaudeCodeProcess.warm (pre-resume)', () => {
  let proc: ClaudeCodeProcess | undefined
  let originalRemoteMcps: string | undefined

  beforeEach(() => {
    calls.length = 0
    mcpServerStatusImpl = null
    originalRemoteMcps = process.env.REMOTE_MCPS
    delete process.env.REMOTE_MCPS
  })

  afterEach(async () => {
    await proc?.dispose()
    proc = undefined
    if (originalRemoteMcps === undefined) delete process.env.REMOTE_MCPS
    else process.env.REMOTE_MCPS = originalRemoteMcps
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('restarts an evicted process once without starting a turn, and the next send reuses it', async () => {
    proc = await evictedProcess('cold')
    const outbound: unknown[] = []
    proc.on('outbound-message', (info) => outbound.push(info))

    await expect(proc.warm()).resolves.toBe(true)

    expect(calls).toHaveLength(2) // the original start + exactly one restart
    expect(calls[1].options.resume).toBe('cli-cold')
    expect(proc.isRunning()).toBe(true)
    // Nothing was queued: no turn, so nothing marks the session busy.
    expect(outbound).toEqual([])

    await proc.sendMessage('back after a pause')
    expect(calls).toHaveLength(2)
    expect(outbound).toEqual([{ expectsResponse: true }])
  })

  it('is a no-op on a live process', async () => {
    proc = new ClaudeCodeProcess({ sessionId: 'live', workingDirectory: '/tmp' })
    await proc.start()

    await expect(proc.warm()).resolves.toBe(false)
    expect(calls).toHaveLength(1)
    expect(proc.isRunning()).toBe(true)
  })

  it('waits out an eviction that is still closing the process, then restarts once', async () => {
    proc = new ClaudeCodeProcess({ sessionId: 'evicting', workingDirectory: '/tmp' })
    await proc.start()

    // The CLI ignores stdin EOF, so the graceful stop holds for its whole window.
    const eviction = proc.stop({ graceful: true, graceMs: 150 })
    const warm = proc.warm()
    await new Promise((r) => setTimeout(r, 50))
    expect(calls).toHaveLength(1) // nothing restarts while the stop is in flight

    await eviction
    await expect(warm).resolves.toBe(true)
    expect(calls).toHaveLength(2)
    expect(proc.isRunning()).toBe(true)
  })

  it('a send arriving before the restart begins makes the pre-resume stand down: one restart', async () => {
    proc = await evictedProcess('send-first')

    // warm() parks on the finished stop; the send overtakes it and restarts itself.
    const warm = proc.warm()
    const send = proc.sendMessage('typed fast')
    await expect(warm).resolves.toBe(false)
    await send

    expect(calls).toHaveLength(2)
    expect(proc.isRunning()).toBe(true)
  })

  it('a send arriving mid-restart waits for it and does not restart again', async () => {
    proc = await evictedProcess('warm-first')
    // A remote MCP was assigned while the CLI slept: the rebuilt query holds
    // until the new server finishes its handshake, which keeps the pre-resume's
    // restart in flight for as long as this test wants.
    process.env.REMOTE_MCPS = CALENDAR
    const handshake = deferred()
    let connected = false
    void handshake.promise.then(() => { connected = true })
    mcpServerStatusImpl = async () => [{ name: 'team_calendar', status: connected ? 'connected' : 'pending' }]

    const warm = proc.warm()
    await vi.waitFor(() => expect(calls).toHaveLength(2))
    let delivered = false
    const send = proc.sendMessage('hello').then(() => { delivered = true })
    await new Promise((r) => setTimeout(r, 300))
    expect(delivered).toBe(false) // held behind the pre-resume, not restarting beside it

    handshake.resolve()
    await expect(warm).resolves.toBe(true)
    await send
    expect(delivered).toBe(true)
    expect(calls).toHaveLength(2)
    expect(calls[1].options.mcpServers).toHaveProperty('team_calendar')
  })

  it('a pre-resume arriving while a cold send restarts is a no-op', async () => {
    proc = await evictedProcess('send-restarting')

    const send = proc.sendMessage('first')
    await expect(proc.warm()).resolves.toBe(false)
    await send

    expect(calls).toHaveLength(2)
  })

  it('concurrent pre-resumes restart once', async () => {
    proc = await evictedProcess('double')

    const results = await Promise.all([proc.warm(), proc.warm()])

    expect(results.sort()).toEqual([false, true])
    expect(calls).toHaveLength(2)
  })

  it('never revives a disposed process', async () => {
    proc = await evictedProcess('deleted')
    await proc.dispose()

    await expect(proc.warm()).resolves.toBe(false)
    expect(calls).toHaveLength(1)
    expect(proc.isRunning()).toBe(false)
  })

  describe('deferred start (host-held credentials)', () => {
    beforeEach(() => {
      vi.stubEnv('SUPERAGENT_HOST_API_URL', 'http://host.test/api')
      vi.stubEnv('PROXY_TOKEN', 'agent-token')
    })

    it('resolves the session runtime from the host, starts on it, and the matching send reuses it', async () => {
      const fetchRuntime = vi.fn(async () => new Response(JSON.stringify(runtime())))
      vi.stubGlobal('fetch', fetchRuntime)
      proc = new ClaudeCodeProcess({
        sessionId: 'resumed', claudeSessionId: 'cli-resumed', workingDirectory: '/tmp', requiresConnectionRuntime: true,
      })
      expect(calls).toHaveLength(0)

      await expect(proc.warm()).resolves.toBe(true)

      expect(fetchRuntime).toHaveBeenCalledOnce()
      const [url, init] = fetchRuntime.mock.calls[0] as unknown as [string, RequestInit]
      expect(url).toBe('http://host.test/api/llm-runtime/resolve')
      expect(JSON.parse(String(init.body))).toEqual({ sessionId: 'resumed' })
      expect(calls).toHaveLength(1)
      expect(calls[0].options.model).toBe('claude-model')
      expect(calls[0].options.env).toMatchObject({ ANTHROPIC_API_KEY: 'session-key' })

      // The host resolves the same runtime for the send: no re-query.
      await proc.sendMessage('hi', undefined, { llmRuntime: runtime() })
      expect(calls).toHaveLength(1)
    })

    it('stands down when a send arrives while the host is still resolving; the send starts on its own runtime', async () => {
      const resolution = deferred<Response>()
      vi.stubGlobal('fetch', vi.fn(() => resolution.promise))
      proc = new ClaudeCodeProcess({
        sessionId: 'racing', claudeSessionId: 'cli-racing', workingDirectory: '/tmp', requiresConnectionRuntime: true,
      })

      const warm = proc.warm()
      await proc.sendMessage('hi', undefined, { llmRuntime: runtime({ model: 'picked-model', env: { ANTHROPIC_API_KEY: 'send-key' } }) })
      expect(calls).toHaveLength(1)

      resolution.resolve(new Response(JSON.stringify(runtime())))
      await expect(warm).resolves.toBe(false)
      expect(calls).toHaveLength(1)
      expect(calls[0].options.model).toBe('picked-model')
      expect(calls[0].options.env).toMatchObject({ ANTHROPIC_API_KEY: 'send-key' })
    })

    it('rejects when the host cannot resolve the runtime, and leaves the process for the next send', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('unavailable', { status: 503 })))
      proc = new ClaudeCodeProcess({
        sessionId: 'no-host', claudeSessionId: 'cli-no-host', workingDirectory: '/tmp', requiresConnectionRuntime: true,
      })

      await expect(proc.warm()).rejects.toThrow('503')
      expect(calls).toHaveLength(0)

      await proc.sendMessage('hi', undefined, { llmRuntime: runtime() })
      expect(calls).toHaveLength(1)
    })
  })
})
