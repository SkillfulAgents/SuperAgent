/**
 * The system prompt's date line must read the day a subprocess starts, not
 * the day the ClaudeCodeProcess object was built: an idle-evicted session is
 * restarted from the same object, and a pre-warmed subprocess is claimed
 * hours after it was spawned.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

type MockQueryCall = { options: Record<string, unknown> }
const calls: MockQueryCall[] = []
const warm = { spawned: 0, claimed: 0, closed: 0 }

vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  function makeQuery(args: { options: Record<string, unknown> }) {
    const abortController = args.options.abortController as AbortController
    let resolvePending: ((result: IteratorResult<never>) => void) | undefined
    const finish = () => {
      resolvePending?.({ value: undefined, done: true })
      resolvePending = undefined
    }
    abortController.signal.addEventListener('abort', finish, { once: true })
    const iter: AsyncIterableIterator<never> & { interrupt: () => Promise<void> } = {
      [Symbol.asyncIterator]() { return this },
      next() {
        if (abortController.signal.aborted) return Promise.resolve({ value: undefined, done: true })
        return new Promise<IteratorResult<never>>((resolve) => { resolvePending = resolve })
      },
      return() { finish(); return Promise.resolve({ value: undefined, done: true } as IteratorResult<never>) },
      throw(err?: unknown) { return Promise.reject(err) },
      interrupt() { return Promise.resolve() },
    }
    return iter
  }
  return {
    query: vi.fn((args: { prompt: unknown; options: Record<string, unknown> }) => {
      calls.push({ options: args.options })
      return makeQuery(args)
    }),
    startup: vi.fn((args: { options: Record<string, unknown> }) => {
      warm.spawned++
      return Promise.resolve({
        query() { warm.claimed++; return makeQuery(args) },
        close() { warm.closed++ },
      })
    }),
  }
})

vi.mock('./mcp-server', () => ({
  createUserInputMcpServer: () => ({}),
  createBrowserMcpServer: () => ({}),
  createComputerUseMcpServer: () => ({}),
  createDashboardsMcpServer: () => ({}),
  createWidgetsMcpServer: () => ({}),
  createAgentsMcpServer: (_getCallerSessionId: () => string) => ({}),
  createChatMcpServer: () => ({}),
}))
vi.mock('./tools/browser', () => ({ createBrowserTools: () => [] }))
vi.mock('./tools/computer-use', () => ({ computerUseTools: [] }))
vi.mock('./file-hooks', () => ({ fileHooks: {}, resolveToolFilePath: () => '' }))
vi.mock('./input-manager', () => ({ inputManager: {}, HUMAN_INPUT_TTL_MS: 24 * 60 * 60 * 1000 }))

import { ClaudeCodeProcess } from './claude-code'

// The process zone is pinned and the instants carry its offset explicitly, so
// the cases below straddle LOCAL midnight without straddling UTC midnight (and
// vice versa) on any host: a UTC-date comparison would fail them.
const ZONE = 'America/Los_Angeles'
const THURSDAY_MORNING = new Date('2026-09-10T10:00:00-07:00') // 17:00Z Thu
const THURSDAY_EVENING = new Date('2026-09-10T18:00:00-07:00') // 01:00Z Fri, still Thursday here
const THURSDAY_LATE = new Date('2026-09-10T23:30:00-07:00')    // 06:30Z Fri
const FRIDAY_EARLY = new Date('2026-09-11T00:30:00-07:00')     // 07:30Z Fri, same UTC day as above

describe('ClaudeCodeProcess system prompt date', () => {
  let savedTz: string | undefined
  let hostZone: string
  beforeEach(() => {
    calls.length = 0
    warm.spawned = warm.claimed = warm.closed = 0
    savedTz = process.env.TZ
    hostZone = Intl.DateTimeFormat().resolvedOptions().timeZone
    process.env.TZ = ZONE
    vi.useFakeTimers({ toFake: ['Date'] })
  })
  afterEach(() => {
    vi.useRealTimers()
    // Deleting TZ does not re-point Node's zone; set it back explicitly.
    process.env.TZ = savedTz ?? hostZone
  })

  it('re-renders the date line when a stopped session restarts on a later day', async () => {
    vi.setSystemTime(THURSDAY_LATE)
    const process = new ClaudeCodeProcess({ sessionId: 's1', workingDirectory: '/tmp' })
    await process.start()
    expect(calls[0].options.systemPrompt).toContain(`Today is Thursday, 2026-09-10 in ${ZONE} (UTC-07:00)`)

    await process.stop()
    vi.setSystemTime(FRIDAY_EARLY)
    await process.sendMessage('hello')
    expect(calls).toHaveLength(2)
    expect(calls[1].options.systemPrompt).toContain('Today is Friday, 2026-09-11')
  })

  it('claims a pre-warmed subprocess spawned the same local day', async () => {
    vi.setSystemTime(THURSDAY_MORNING)
    const process = new ClaudeCodeProcess({ sessionId: 's2', workingDirectory: '/tmp' })
    await process.prewarm()
    vi.setSystemTime(THURSDAY_EVENING)
    await process.start()
    expect(warm).toEqual({ spawned: 1, claimed: 1, closed: 0 })
    expect(calls).toHaveLength(0)
  })

  it('discards a pre-warmed subprocess spawned on an earlier local day and starts cold', async () => {
    vi.setSystemTime(THURSDAY_LATE)
    const process = new ClaudeCodeProcess({ sessionId: 's3', workingDirectory: '/tmp' })
    await process.prewarm()
    vi.setSystemTime(FRIDAY_EARLY)
    await process.start()
    expect(warm).toEqual({ spawned: 1, claimed: 0, closed: 1 })
    expect(calls).toHaveLength(1)
    expect(calls[0].options.systemPrompt).toContain('Today is Friday, 2026-09-11')
  })
})
