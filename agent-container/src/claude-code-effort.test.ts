/**
 * Unit test for effort-change handling in ClaudeCodeProcess.
 *
 * The SDK `query()` function is mocked so we can verify that:
 *   - A sendMessage call with a NEW effort level triggers interrupt+restart
 *     (i.e. query() is invoked a second time with the new effort in options).
 *   - A sendMessage call with the SAME effort does NOT rebuild the query.
 *   - A pre-existing session whose stored effort is undefined treats 'high'
 *     as the current level (so the first post-upgrade message with effort='high'
 *     does not trigger a spurious restart).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

type MockQueryCall = { options: Record<string, unknown> }
const calls: MockQueryCall[] = []

// Stub the SDK before importing ClaudeCodeProcess.
vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  // Returns an async iterator that never yields until aborted — good enough to
  // model a running session for the purposes of this test.
  function makeQuery(_args: { prompt: unknown; options: Record<string, unknown> }) {
    const iter: AsyncIterableIterator<never> & { interrupt: () => Promise<void> } = {
      [Symbol.asyncIterator]() {
        return this
      },
      next() {
        return new Promise<IteratorResult<never>>(() => {
          /* pending forever — real abort handled via AbortController in process */
        })
      },
      return() {
        return Promise.resolve({ value: undefined, done: true } as IteratorResult<never>)
      },
      throw(err?: unknown) {
        return Promise.reject(err)
      },
      interrupt() {
        return Promise.resolve()
      },
    }
    return iter
  }

  return {
    query: vi.fn((args: { prompt: unknown; options: Record<string, unknown> }) => {
      calls.push({ options: args.options })
      return makeQuery(args)
    }),
  }
})

// MCP server factories are invoked during createQuery; stub them to return empty servers.
vi.mock('./mcp-server', () => ({
  createUserInputMcpServer: () => ({}),
  createBrowserMcpServer: () => ({}),
  createComputerUseMcpServer: () => ({}),
  createDashboardsMcpServer: () => ({}),
}))

vi.mock('./tools/browser', () => ({
  browserTools: [],
  setCurrentBrowserSessionId: () => {},
}))

vi.mock('./tools/computer-use', () => ({
  computerUseTools: [],
}))

vi.mock('./file-hooks', () => ({
  fileHooks: {},
  resolveToolFilePath: () => '',
}))

vi.mock('./input-manager', () => ({
  inputManager: {},
}))

import { ClaudeCodeProcess } from './claude-code'

describe('ClaudeCodeProcess effort handling', () => {
  beforeEach(() => {
    calls.length = 0
  })

  afterEach(async () => {
    // Nothing to tear down — process.stop() triggers abort which our stub ignores.
  })

  // Interrupt's wait-for-stop polls up to 5 s before falling through; our mock
  // doesn't honor the abort signal, so each effort-change test waits that full
  // window. Raise the per-test timeout accordingly.
  it('rebuilds the query with the new effort when effort changes', { timeout: 15000 }, async () => {
    const process = new ClaudeCodeProcess({
      sessionId: 'test-session-1',
      workingDirectory: '/tmp',
      effort: 'high',
    })

    await process.start()
    expect(calls).toHaveLength(1)
    expect(calls[0].options.effort).toBe('high')

    // Send a message with a DIFFERENT effort level — should trigger interrupt+restart.
    await process.sendMessage('hello', undefined, 'low')

    // interrupt() is async but process.sendMessage awaits it; after it returns,
    // createQuery has been called again with the new effort.
    expect(calls).toHaveLength(2)
    expect(calls[1].options.effort).toBe('low')
  })

  it('does not rebuild the query when the same effort is passed', async () => {
    const process = new ClaudeCodeProcess({
      sessionId: 'test-session-2',
      workingDirectory: '/tmp',
      effort: 'high',
    })

    await process.start()
    expect(calls).toHaveLength(1)

    await process.sendMessage('hello', undefined, 'high')

    // Same effort → no restart → still one call.
    expect(calls).toHaveLength(1)
  })

  it('treats undefined stored effort as high so first high message does not restart', { timeout: 15000 }, async () => {
    // Simulates a session created before this feature (no persisted effort).
    const process = new ClaudeCodeProcess({
      sessionId: 'test-session-3',
      workingDirectory: '/tmp',
      // effort intentionally omitted
    })

    await process.start()
    expect(calls).toHaveLength(1)
    // Initial createQuery omits effort entirely when not set.
    expect(calls[0].options.effort).toBeUndefined()

    // User sends first post-upgrade message with effort='high' (UI default).
    // Because stored effort is undefined we treat it as 'high' — no restart expected.
    await process.sendMessage('hello', undefined, 'high')
    expect(calls).toHaveLength(1)

    // But a non-'high' level should restart.
    await process.sendMessage('hello again', undefined, 'low')
    expect(calls).toHaveLength(2)
    expect(calls[1].options.effort).toBe('low')
  })
})
