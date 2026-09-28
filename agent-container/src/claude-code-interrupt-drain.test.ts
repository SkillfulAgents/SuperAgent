/**
 * Regression test for the hard-interrupt restart path dropping the abort's
 * terminal frames.
 *
 * interrupt() with scope 'all' aborts the live query and restarts it parked.
 * The CLI answers the abort with a result (error_during_execution) and a
 * session_state_changed:idle — the frames the settlement tracker needs to
 * read the session as settled so the reaper can evict the parked process.
 * restartQuery() used to call the SDK iterator's return() straight after the
 * abort; that ends the iteration at once and the loop never saw the frames,
 * so every hard-interrupted session stayed busy forever (live: the
 * session-gc-durability suite's "interrupted session settles" case). The
 * loop must drain first; return() only then.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const events: string[] = []
// Frames the mocked CLI writes in response to an abort, in order.
const abortFrames = [
  { type: 'result', subtype: 'error_during_execution', session_id: 'sid' },
  { type: 'system', subtype: 'session_state_changed', state: 'idle', session_id: 'sid' },
]

vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  function makeQuery(args: { prompt: unknown; options: { abortController: AbortController } }) {
    const signal = args.options.abortController.signal
    const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' })
    let pending = [...abortFrames]
    let ended = false
    const iter = {
      [Symbol.asyncIterator]() {
        return this
      },
      next(): Promise<IteratorResult<unknown>> {
        if (ended) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve, reject) => {
          const drain = () =>
            setTimeout(() => {
              if (ended) return resolve({ value: undefined, done: true })
              const frame = pending.shift()
              if (frame) resolve({ value: frame, done: false })
              else reject(abortError)
            }, 20)
          if (signal.aborted) drain()
          else signal.addEventListener('abort', drain, { once: true })
        })
      },
      // The SDK's return() tears the iteration down: whatever the CLI still
      // had to say is gone.
      return() {
        ended = true
        pending = []
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
      events.push('query')
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
}))
vi.mock('./tools/browser', () => ({ createBrowserTools: () => [] }))
vi.mock('./tools/computer-use', () => ({ computerUseTools: [] }))
vi.mock('./file-hooks', () => ({ fileHooks: {}, resolveToolFilePath: () => '' }))
vi.mock('./input-manager', () => ({ inputManager: {}, HUMAN_INPUT_TTL_MS: 24 * 60 * 60 * 1000 }))

import { ClaudeCodeProcess } from './claude-code'

describe('ClaudeCodeProcess hard interrupt drains the aborted query', () => {
  beforeEach(() => {
    events.length = 0
  })

  it('the abort result and idle reach listeners before the parked query starts', async () => {
    const proc = new ClaudeCodeProcess({ sessionId: 's1', workingDirectory: '/tmp' })
    proc.on('message', (m: { type: string; subtype?: string; state?: string }) => {
      events.push(m.type === 'system' ? `${m.type}:${m.subtype}:${m.state}` : `${m.type}:${m.subtype}`)
    })
    await proc.start()
    expect(events).toEqual(['query'])

    const outcome = await proc.interrupt()
    expect(outcome.interrupted).toBe(true)
    expect(outcome.processKept).toBe(false)

    // Frames first, in wire order; the replacement query only after them.
    expect(events).toEqual([
      'query',
      'result:error_during_execution',
      'system:session_state_changed:idle',
      'query',
    ])
    expect(proc.isRunning()).toBe(true)

    await proc.stop()
  })
})
