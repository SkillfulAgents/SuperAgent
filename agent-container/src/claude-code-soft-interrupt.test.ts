/**
 * Stop with a live process: interrupt({ scope: 'turn' }) sends the SDK
 * interrupt control request and keeps the CLI process (so background tasks
 * live on), falling back to the abort-and-re-query restart only when the CLI
 * gives no proof it honors the soft path. interrupt({ scope: 'all' }) is the
 * restart. stopTask() forwards one task id to the SDK.
 *
 * The SDK is mocked as a controllable stream: tests push the frames the CLI
 * would write (init with capabilities, state transitions, the aborted turn's
 * result) and observe which query calls and control requests happen.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

type Frame = Record<string, unknown>

interface MockQuery {
  push: (frame: Frame) => void
  interrupt: ReturnType<typeof vi.fn>
  stopTask: ReturnType<typeof vi.fn>
  signal: AbortSignal
}

const queryCalls: Array<{ options: Record<string, unknown> }> = []
const queries: MockQuery[] = []
// What the mocked CLI does when it receives the interrupt control request:
// resolve the receipt (or never), and optionally write the aborted result.
let interruptBehavior: {
  receipt: unknown | 'hang'
  onInterrupt?: (push: (frame: Frame) => void) => void
}

vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  function makeQuery(args: { options: { abortController: AbortController } }) {
    const signal = args.options.abortController.signal
    const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' })
    const buffered: Frame[] = []
    let waiting: { resolve: (r: IteratorResult<Frame>) => void; reject: (e: unknown) => void } | null = null
    const push = (frame: Frame) => {
      if (waiting) {
        const w = waiting
        waiting = null
        w.resolve({ value: frame, done: false })
      } else {
        buffered.push(frame)
      }
    }
    signal.addEventListener('abort', () => {
      if (waiting) {
        const w = waiting
        waiting = null
        w.reject(abortError)
      }
    })
    const query: MockQuery & Record<string, unknown> = {
      signal,
      push,
      [Symbol.asyncIterator]() {
        return this
      },
      next() {
        return new Promise<IteratorResult<Frame>>((resolve, reject) => {
          if (buffered.length > 0) resolve({ value: buffered.shift()!, done: false })
          else if (signal.aborted) reject(abortError)
          else waiting = { resolve, reject }
        })
      },
      return() {
        return Promise.resolve({ value: undefined, done: true } as IteratorResult<Frame>)
      },
      throw(err?: unknown) {
        return Promise.reject(err)
      },
      interrupt: vi.fn(async () => {
        interruptBehavior.onInterrupt?.(push)
        if (interruptBehavior.receipt === 'hang') return new Promise(() => {})
        return interruptBehavior.receipt
      }),
      stopTask: vi.fn(async () => {}),
      setModel: () => Promise.resolve(),
      supportedCommands: () => Promise.resolve([]),
    }
    queries.push(query)
    return query
  }

  return {
    query: vi.fn((args: { options: { abortController: AbortController } }) => {
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
  createWidgetsMcpServer: () => ({}),
}))
vi.mock('./tools/browser', () => ({ createBrowserTools: () => [] }))
vi.mock('./tools/computer-use', () => ({ computerUseTools: [] }))
vi.mock('./file-hooks', () => ({ fileHooks: {}, resolveToolFilePath: () => '' }))
vi.mock('./input-manager', () => ({ inputManager: {}, HUMAN_INPUT_TTL_MS: 24 * 60 * 60 * 1000 }))

import { ClaudeCodeProcess } from './claude-code'

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))

function initFrame(capabilities: string[]): Frame {
  return { type: 'system', subtype: 'init', session_id: 'sess-1', slash_commands: [], capabilities }
}

const stateFrame = (state: 'idle' | 'running'): Frame => ({
  type: 'system', subtype: 'session_state_changed', state, session_id: 'sess-1',
})

const abortedResult: Frame = {
  type: 'result', subtype: 'success', is_error: true, terminal_reason: 'aborted_streaming', session_id: 'sess-1',
}

async function startProcess(capabilities = ['interrupt_receipt_v1']) {
  const proc = new ClaudeCodeProcess({ sessionId: 's1', workingDirectory: '/tmp' })
  await proc.start()
  const query = queries[0]
  query.push(initFrame(capabilities))
  await tick()
  return { proc, query }
}

describe('ClaudeCodeProcess soft interrupt', () => {
  let proc: ClaudeCodeProcess | null = null

  beforeEach(() => {
    queryCalls.length = 0
    queries.length = 0
    interruptBehavior = {
      receipt: { still_queued: [] },
      onInterrupt: (push) => setTimeout(() => push(abortedResult), 10),
    }
  })

  afterEach(async () => {
    await proc?.stop()
    proc = null
  })

  it('declares the per-task stop affordance on the query', async () => {
    ;({ proc } = await startProcess())
    expect(queryCalls[0].options.perTaskStopAffordance).toBe(true)
  })

  it('scope turn ends the turn in place and keeps the process', async () => {
    let query: MockQuery
    ;({ proc, query } = await startProcess())
    const messages: Frame[] = []
    proc.on('message', (m: Frame) => messages.push(m))

    const outcome = await proc.interrupt({ scope: 'turn' })

    expect(outcome).toEqual({ interrupted: true, discardedUuids: [], processKept: true })
    expect(query.interrupt).toHaveBeenCalledTimes(1)
    expect(query.signal.aborted).toBe(false)
    expect(queryCalls).toHaveLength(1)
    expect(proc.isRunning()).toBe(true)
    // The aborted turn's result was relayed before interrupt() returned.
    expect(messages.some((m) => m.type === 'result')).toBe(true)
  })

  it('scope all aborts and re-creates the query', async () => {
    let query: MockQuery
    ;({ proc, query } = await startProcess())

    const outcome = await proc.interrupt({ scope: 'all' })

    expect(outcome).toEqual({ interrupted: true, discardedUuids: [], processKept: false })
    expect(query.signal.aborted).toBe(true)
    expect(queryCalls).toHaveLength(2)
    expect(proc.isRunning()).toBe(true)
  })

  it('falls back to the restart when the CLI does not advertise the interrupt receipt', async () => {
    let query: MockQuery
    ;({ proc, query } = await startProcess([]))

    const outcome = await proc.interrupt({ scope: 'turn' })

    expect(outcome.processKept).toBe(false)
    expect(query.signal.aborted).toBe(true)
    expect(queryCalls).toHaveLength(2)
  })

  it('falls back to the restart when the receipt never arrives', async () => {
    interruptBehavior = { receipt: 'hang' }
    let query: MockQuery
    ;({ proc, query } = await startProcess())

    const outcome = await proc.interrupt({ scope: 'turn' })

    expect(outcome.processKept).toBe(false)
    expect(query.signal.aborted).toBe(true)
    expect(queryCalls).toHaveLength(2)
  }, 15000)

  it('falls back to the restart when the CLI acknowledges but never ends the turn', async () => {
    interruptBehavior = { receipt: { still_queued: [] } }
    let query: MockQuery
    ;({ proc, query } = await startProcess())

    const outcome = await proc.interrupt({ scope: 'turn' })

    expect(outcome.processKept).toBe(false)
    expect(query.signal.aborted).toBe(true)
    expect(queryCalls).toHaveLength(2)
  }, 15000)

  it('is a no-op for the turn when the runtime is idle between turns', async () => {
    let query: MockQuery
    ;({ proc, query } = await startProcess())
    query.push(stateFrame('idle'))
    await tick()

    const outcome = await proc.interrupt({ scope: 'turn' })

    expect(outcome).toEqual({ interrupted: false, discardedUuids: [], processKept: true })
    expect(query.interrupt).not.toHaveBeenCalled()
    expect(queryCalls).toHaveLength(1)
  })

  it('a send after idle makes the next turn interruptible again', async () => {
    let query: MockQuery
    ;({ proc, query } = await startProcess())
    query.push(stateFrame('idle'))
    await tick()
    await proc.sendMessage('carry on')

    const outcome = await proc.interrupt({ scope: 'turn' })

    expect(outcome.interrupted).toBe(true)
    expect(outcome.processKept).toBe(true)
    expect(query.interrupt).toHaveBeenCalledTimes(1)
  })

  it('cancels queued messages on a soft stop and reports them discarded', async () => {
    interruptBehavior = {
      receipt: { still_queued: ['11111111-1111-4111-8111-111111111111'] },
      onInterrupt: (push) => setTimeout(() => push(abortedResult), 10),
    }
    let query: MockQuery
    ;({ proc, query } = await startProcess())
    ;(query as unknown as Record<string, unknown>).cancelAsyncMessage = vi.fn(async () => true)
    const discarded: string[] = []
    proc.on('message', (m: Frame) => {
      if (m.type === 'command_lifecycle' && m.state === 'discarded') discarded.push(m.command_uuid as string)
    })

    const outcome = await proc.interrupt({ scope: 'turn' })

    expect(outcome.discardedUuids).toEqual(['11111111-1111-4111-8111-111111111111'])
    expect(discarded).toEqual(['11111111-1111-4111-8111-111111111111'])
    expect(outcome.processKept).toBe(true)
  })

  it('still reports the messages a soft attempt cancelled when it falls back to the restart', async () => {
    // The receipt arrives and its queued message is cancelled, but the turn
    // never ends: the restart takes over, and the cancelled message must not
    // vanish from the outcome (the renderer restores it to the composer).
    const uuid = '22222222-2222-4222-8222-222222222222'
    // Like the CLI, the mock stops listing a message once it was cancelled,
    // so the restart's own receipt cannot rediscover it.
    const cancelled = new Set<string>()
    interruptBehavior = {
      receipt: { still_queued: [uuid] },
      onInterrupt: () => {
        interruptBehavior.receipt = { still_queued: [uuid].filter((u) => !cancelled.has(u)) }
      },
    }
    let query: MockQuery
    ;({ proc, query } = await startProcess())
    ;(query as unknown as Record<string, unknown>).cancelAsyncMessage = vi.fn(async (u: string) => {
      cancelled.add(u)
      return true
    })
    const discarded: string[] = []
    proc.on('message', (m: Frame) => {
      if (m.type === 'command_lifecycle' && m.state === 'discarded') discarded.push(m.command_uuid as string)
    })

    const outcome = await proc.interrupt({ scope: 'turn' })

    expect(outcome.processKept).toBe(false)
    expect(outcome.discardedUuids).toEqual([uuid])
    expect(discarded).toEqual([uuid])
  }, 15000)

  it('stopTask forwards the task id to the SDK', async () => {
    let query: MockQuery
    ;({ proc, query } = await startProcess())

    await expect(proc.stopTask('bg_123')).resolves.toBe(true)
    expect(query.stopTask).toHaveBeenCalledWith('bg_123')
  })

  it('stopTask reports false once the process is stopped', async () => {
    ;({ proc } = await startProcess())
    await proc.stop()

    await expect(proc.stopTask('bg_123')).resolves.toBe(false)
  })
})
