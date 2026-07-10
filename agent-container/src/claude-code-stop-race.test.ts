/**
 * Regression test for the evict-then-resume teardown race.
 *
 * stop() used to sleep a fixed 100ms and return without awaiting the
 * processMessages loop. When SDK teardown outlived that sleep, a restart
 * (sendMessage after eviction) started query B while query A was still
 * unwinding; A's finally then cleared the shared isReady/isProcessing flags,
 * so the next message spawned query C without ever closing B — leaking B's
 * subprocess and double-routing its messages. stop() now awaits the loop
 * (bounded), and the finally is generation-guarded for the timeout path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const queryCalls: unknown[] = []
// How long after abort the mocked SDK query takes to actually unwind.
let teardownDelayMs = 250

vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  function makeQuery(args: { prompt: unknown; options: { abortController: AbortController } }) {
    const signal = args.options.abortController.signal
    const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' })
    const iter = {
      [Symbol.asyncIterator]() {
        return this
      },
      next() {
        return new Promise<IteratorResult<never>>((_, reject) => {
          const fail = () => setTimeout(() => reject(abortError), teardownDelayMs)
          if (signal.aborted) fail()
          else signal.addEventListener('abort', fail, { once: true })
        })
      },
      return() {
        return Promise.resolve({ value: undefined, done: true } as IteratorResult<never>)
      },
      throw(err?: unknown) {
        return Promise.reject(err)
      },
      interrupt: () => Promise.resolve(),
      setModel: () => Promise.resolve(),
    }
    return iter
  }

  return {
    query: vi.fn((args: { prompt: unknown; options: { abortController: AbortController } }) => {
      queryCalls.push(args)
      return makeQuery(args)
    }),
  }
})

vi.mock('./mcp-server', () => ({
  createUserInputMcpServer: () => ({}),
  createBrowserMcpServer: () => ({}),
  createComputerUseMcpServer: () => ({}),
  createDashboardsMcpServer: () => ({}),
  createAgentsMcpServer: () => ({}),
  createChatMcpServer: () => ({}),
}))
vi.mock('./tools/browser', () => ({ createBrowserTools: () => [] }))
vi.mock('./tools/computer-use', () => ({ computerUseTools: [] }))
vi.mock('./file-hooks', () => ({ fileHooks: {}, resolveToolFilePath: () => '' }))
vi.mock('./input-manager', () => ({ inputManager: {} }))

import { ClaudeCodeProcess } from './claude-code'

describe('ClaudeCodeProcess stop/restart teardown race', () => {
  beforeEach(() => {
    queryCalls.length = 0
    teardownDelayMs = 250
  })

  it('stop() waits for the query loop to unwind before returning', async () => {
    const proc = new ClaudeCodeProcess({ sessionId: 's1', workingDirectory: '/tmp' })
    await proc.start()
    expect(proc.isRunning()).toBe(true)

    const before = Date.now()
    await proc.stop()
    // Must have outlasted the mocked 250ms teardown, not just a fixed sleep.
    expect(Date.now() - before).toBeGreaterThanOrEqual(240)
    expect(proc.isRunning()).toBe(false)
  })

  it('a restart during slow teardown cannot be marked stopped by the old loop', async () => {
    const proc = new ClaudeCodeProcess({ sessionId: 's2', workingDirectory: '/tmp' })
    await proc.start()
    expect(queryCalls.length).toBe(1)

    await proc.stop() // awaits teardown → old loop fully unwound
    await proc.sendMessage('follow-up') // cold path → restart → query B
    expect(queryCalls.length).toBe(2)
    expect(proc.isRunning()).toBe(true)

    // Give any straggler teardown from query A time to fire its finally.
    await new Promise((r) => setTimeout(r, teardownDelayMs + 100))
    expect(proc.isRunning()).toBe(true) // B is still the live query

    // And the next message must NOT spawn a third query.
    await proc.sendMessage('again')
    expect(queryCalls.length).toBe(2)

    await proc.stop()
  })

  it('interrupt() landing during a stop() teardown must not revive the query', async () => {
    const proc = new ClaudeCodeProcess({ sessionId: 's4', workingDirectory: '/tmp' })
    await proc.start()
    expect(queryCalls.length).toBe(1)

    // Eviction begins stopping; a user Stop (interruptSession) races in while
    // the old loop is still unwinding.
    const stopP = proc.stop()
    const intP = proc.interrupt()
    await Promise.all([stopP, intP])
    // Let any deferred restart from interrupt() surface.
    await new Promise((r) => setTimeout(r, teardownDelayMs + 200))

    // The stop must win: no second query may have been spawned, and the
    // process must read as cold so the reaper/manager stay consistent.
    expect(queryCalls.length).toBe(1)
    expect(proc.isRunning()).toBe(false)
  })

  it('a stop() landing while interrupt() is mid-flight also suppresses the restart', async () => {
    const proc = new ClaudeCodeProcess({ sessionId: 's4b', workingDirectory: '/tmp' })
    await proc.start()
    expect(queryCalls.length).toBe(1)

    // Reverse order: interrupt enters first (passes its entry guard, waits
    // for the loop to unwind), then the eviction/delete stop races in.
    const intP = proc.interrupt()
    await new Promise((r) => setTimeout(r, 50))
    const stopP = proc.stop()
    await Promise.all([intP, stopP])
    await new Promise((r) => setTimeout(r, teardownDelayMs + 200))

    expect(queryCalls.length).toBe(1)
    expect(proc.isRunning()).toBe(false)
  })

  it('a disposed process (deleteSession) cannot be revived by late sendMessage or interrupt', async () => {
    const proc = new ClaudeCodeProcess({ sessionId: 's5', workingDirectory: '/tmp' })
    await proc.start()
    expect(queryCalls.length).toBe(1)

    // deleteSession semantics: the session is gone for good — a straggler
    // MCP-injection continuation (addRemoteMcpServer's setTimeout closure
    // calls interrupt + sendMessage directly) must not resurrect a subprocess
    // that no longer belongs to any tracked session.
    await proc.dispose()
    expect(proc.isRunning()).toBe(false)

    const outcome = await proc.interrupt()
    expect(outcome.interrupted).toBe(false)
    await expect(proc.sendMessage('straggler')).rejects.toThrow()

    await new Promise((r) => setTimeout(r, teardownDelayMs + 200))
    expect(queryCalls.length).toBe(1)
    expect(proc.isRunning()).toBe(false)
  })

  it('every sendMessage emits outbound-message (settlement visibility for bypass callers)', async () => {
    const proc = new ClaudeCodeProcess({ sessionId: 's6', workingDirectory: '/tmp' })
    await proc.start()

    const outbound: Array<{ expectsResponse: boolean }> = []
    proc.on('outbound-message', (info: { expectsResponse: boolean }) => outbound.push(info))

    await proc.sendMessage('a real turn')
    await proc.sendMessage('a transcript-only append', undefined, { shouldQuery: false })

    expect(outbound).toEqual([{ expectsResponse: true }, { expectsResponse: false }])
    await proc.stop()
  })

  it('graceful stop falls back to abort when the loop ignores the closed queue', async () => {
    // The mocked query never ends on queue-close (like a wedged CLI): the
    // graceful window must expire and the abort must still tear it down.
    const proc = new ClaudeCodeProcess({ sessionId: 's7', workingDirectory: '/tmp' })
    await proc.start()

    const before = Date.now()
    await proc.stop({ graceful: true, graceMs: 100 })
    const elapsed = Date.now() - before
    expect(elapsed).toBeGreaterThanOrEqual(100 + 240) // grace + mocked teardown
    expect(proc.isRunning()).toBe(false)
  })

  it('generation guard: even a teardown that outlives the stop() bound cannot clobber the new query', async () => {
    // Teardown slower than stop()'s 5s wait bound — stop() gives up waiting,
    // sendMessage restarts, and A's finally fires AFTER B is live.
    teardownDelayMs = 5600
    const proc = new ClaudeCodeProcess({ sessionId: 's3', workingDirectory: '/tmp' })
    await proc.start()

    await proc.stop() // returns at the 5s bound, A still unwinding
    teardownDelayMs = 250 // subsequent queries tear down promptly
    await proc.sendMessage('follow-up') // query B
    expect(queryCalls.length).toBe(2)
    expect(proc.isRunning()).toBe(true)

    // A's finally fires ~600ms from now — the generation guard must ignore it.
    await new Promise((r) => setTimeout(r, 900))
    expect(proc.isRunning()).toBe(true)
    await proc.sendMessage('again')
    expect(queryCalls.length).toBe(2)

    await proc.stop()
  }, 15_000)
})
