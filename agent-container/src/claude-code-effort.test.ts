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
const setModelCalls: (string | undefined)[] = []

// Stub the SDK before importing ClaudeCodeProcess.
vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  // Returns an async iterator that never yields until aborted — good enough to
  // model a running session for the purposes of this test.
  function makeQuery(_args: { prompt: unknown; options: Record<string, unknown> }) {
    const iter: AsyncIterableIterator<never> & {
      interrupt: () => Promise<void>
      setModel: (model?: string) => Promise<void>
    } = {
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
      setModel(model?: string) {
        setModelCalls.push(model)
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
  createAgentsMcpServer: (_getCallerSessionId: () => string) => ({}),
  createChatMcpServer: () => ({}),
}))

vi.mock('./tools/browser', () => ({
  createBrowserTools: () => [],
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
    await process.sendMessage('hello', undefined, { effort: 'low' })

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

    await process.sendMessage('hello', undefined, { effort: 'high' })

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
    await process.sendMessage('hello', undefined, { effort: 'high' })
    expect(calls).toHaveLength(1)

    // But a non-'high' level should restart.
    await process.sendMessage('hello again', undefined, { effort: 'low' })
    expect(calls).toHaveLength(2)
    expect(calls[1].options.effort).toBe('low')
  })
})

describe('ClaudeCodeProcess model handling', () => {
  beforeEach(() => {
    calls.length = 0
    setModelCalls.length = 0
  })

  it('switches model dynamically via setModel without rebuilding the query', async () => {
    const process = new ClaudeCodeProcess({
      sessionId: 'test-model-1',
      workingDirectory: '/tmp',
      model: 'claude-sonnet-4-6',
    })

    await process.start()
    expect(calls).toHaveLength(1)
    // The host resolves to a concrete id; the container forwards it unchanged.
    expect(calls[0].options.model).toBe('claude-sonnet-4-6')

    // Switching to Opus mid-session should call setModel on the running query —
    // no interrupt, no second query() call.
    await process.sendMessage('hello', undefined, { model: 'claude-opus-4-7' })

    expect(calls).toHaveLength(1)
    expect(setModelCalls).toEqual(['claude-opus-4-7'])
  })

  it('does not call setModel for the same concrete id, but treats a different version as a real switch', async () => {
    const process = new ClaudeCodeProcess({
      sessionId: 'test-model-2',
      workingDirectory: '/tmp',
      model: 'claude-opus-4-7',
    })

    await process.start()
    expect(calls).toHaveLength(1)

    // Identical concrete id — no restart, no setModel.
    await process.sendMessage('hello', undefined, { model: 'claude-opus-4-7' })
    expect(calls).toHaveLength(1)
    expect(setModelCalls).toHaveLength(0)

    // A different pinned version of the same family is now a real switch
    // (concrete-id compare, post-SUP-275) — setModel on the running query.
    await process.sendMessage('hello again', undefined, { model: 'claude-opus-4-6' })
    expect(calls).toHaveLength(1)
    expect(setModelCalls).toEqual(['claude-opus-4-6'])
  })

  it('combined effort + model change restarts the query exactly once with both new values', { timeout: 15000 }, async () => {
    const process = new ClaudeCodeProcess({
      sessionId: 'test-model-3',
      workingDirectory: '/tmp',
      effort: 'high',
      model: 'claude-sonnet-4-6',
    })

    await process.start()
    expect(calls).toHaveLength(1)
    expect(calls[0].options.effort).toBe('high')
    expect(calls[0].options.model).toBe('claude-sonnet-4-6')

    // Effort can only change via re-query, so the model rides along on that
    // restart rather than calling setModel separately.
    await process.sendMessage('hi', undefined, { effort: 'low', model: 'claude-haiku-4-5' })

    expect(calls).toHaveLength(2)
    expect(calls[1].options.effort).toBe('low')
    expect(calls[1].options.model).toBe('claude-haiku-4-5')
    expect(setModelCalls).toHaveLength(0)
  })

  it('falls back to interrupt+restart when setModel throws', { timeout: 15000 }, async () => {
    const process = new ClaudeCodeProcess({
      sessionId: 'test-model-4',
      workingDirectory: '/tmp',
      model: 'claude-sonnet-4-6',
    })

    await process.start()
    expect(calls).toHaveLength(1)

    // Force the next setModel call to fail.
    const failOnce = vi.fn().mockRejectedValueOnce(new Error('not in streaming mode'))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(process as any).queryInstance.setModel = failOnce

    await process.sendMessage('hello', undefined, { model: 'claude-opus-4-7' })

    expect(failOnce).toHaveBeenCalledWith('claude-opus-4-7')
    // Restart happened after the failure.
    expect(calls).toHaveLength(2)
    expect(calls[1].options.model).toBe('claude-opus-4-7')
  })
})

describe('ClaudeCodeProcess model prompt hints', () => {
  beforeEach(() => {
    calls.length = 0
  })

  it('injects model-specific prompt hints into the system prompt', async () => {
    const process = new ClaudeCodeProcess({
      sessionId: 'test-prompt-hints',
      workingDirectory: '/tmp',
      modelPromptHints: ['Use exact ToolSearch names.', 'Do not send pages as an empty string.'],
    })

    await process.start()
    expect(calls).toHaveLength(1)
    expect(calls[0].options.systemPrompt).toContain('## Model-Specific Instructions')
    expect(calls[0].options.systemPrompt).toContain('- Use exact ToolSearch names.')
    expect(calls[0].options.systemPrompt).toContain('- Do not send pages as an empty string.')
  })
})
