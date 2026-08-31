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
import { describe, it, expect, vi, beforeEach } from 'vitest'

type MockQueryCall = { options: Record<string, unknown> }
const calls: MockQueryCall[] = []
const setModelCalls: (string | undefined)[] = []

// Stub the SDK before importing ClaudeCodeProcess.
vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  // Model a running SDK iterator that actually honors the AbortController.
  // This lets interrupt() observe processMessages() unwind immediately instead
  // of paying its 5-second hung-SDK fallback in every restart test.
  function makeQuery(args: { prompt: unknown; options: Record<string, unknown> }) {
    const abortController = args.options.abortController as AbortController
    let resolvePending:
      | ((result: IteratorResult<never>) => void)
      | undefined
    const finish = () => {
      resolvePending?.({ value: undefined, done: true })
      resolvePending = undefined
    }
    abortController.signal.addEventListener('abort', finish, { once: true })

    const iter: AsyncIterableIterator<never> & {
      interrupt: () => Promise<void>
      setModel: (model?: string) => Promise<void>
    } = {
      [Symbol.asyncIterator]() {
        return this
      },
      next() {
        if (abortController.signal.aborted) {
          return Promise.resolve({ value: undefined, done: true })
        }
        return new Promise<IteratorResult<never>>((resolve) => {
          resolvePending = resolve
        })
      },
      return() {
        finish()
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
  createBrowserTools: () => [
    { name: 'browser_open' },
    { name: 'browser_get_state' },
    { name: 'browser_snapshot' },
    { name: 'browser_click' },
    { name: 'browser_close' },
  ],
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
  HUMAN_INPUT_TTL_MS: 24 * 60 * 60 * 1000,
}))

import { ClaudeCodeProcess } from './claude-code'

describe('ClaudeCodeProcess effort handling', () => {
  beforeEach(() => {
    calls.length = 0
  })

  it('rebuilds the query with the new effort when effort changes', async () => {
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

  it('treats undefined stored effort as high so first high message does not restart', async () => {
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

describe('ClaudeCodeProcess speed handling', () => {
  beforeEach(() => {
    calls.length = 0
  })

  const speedHeaderOf = (call: MockQueryCall): string | undefined => {
    const env = call.options.env as Record<string, string | undefined>
    return env.ANTHROPIC_CUSTOM_HEADERS?.split('\n').find((l) => l.startsWith('X-Superagent-Speed:'))
  }

  it('bakes the speed header into the query env at creation', async () => {
    const process = new ClaudeCodeProcess({
      sessionId: 'test-speed-1',
      workingDirectory: '/tmp',
      speed: 'fast',
    })

    await process.start()
    expect(calls).toHaveLength(1)
    expect(speedHeaderOf(calls[0])).toBe('X-Superagent-Speed: fast')
  })

  it("emits no speed header for 'normal' or unset speed", async () => {
    const p1 = new ClaudeCodeProcess({ sessionId: 'test-speed-2a', workingDirectory: '/tmp', speed: 'normal' })
    await p1.start()
    const p2 = new ClaudeCodeProcess({ sessionId: 'test-speed-2b', workingDirectory: '/tmp' })
    await p2.start()
    expect(calls).toHaveLength(2)
    expect(speedHeaderOf(calls[0])).toBeUndefined()
    expect(speedHeaderOf(calls[1])).toBeUndefined()
  })

  it('rebuilds the query with the new header when speed changes', { timeout: 15000 }, async () => {
    const process = new ClaudeCodeProcess({
      sessionId: 'test-speed-3',
      workingDirectory: '/tmp',
      speed: 'normal',
    })

    await process.start()
    expect(calls).toHaveLength(1)

    await process.sendMessage('hello', undefined, { speed: 'fast' })

    expect(calls).toHaveLength(2)
    expect(speedHeaderOf(calls[1])).toBe('X-Superagent-Speed: fast')
  })

  it('does not rebuild the query when the same speed is passed', async () => {
    const process = new ClaudeCodeProcess({
      sessionId: 'test-speed-4',
      workingDirectory: '/tmp',
      speed: 'fast',
    })

    await process.start()
    expect(calls).toHaveLength(1)

    await process.sendMessage('hello', undefined, { speed: 'fast' })
    expect(calls).toHaveLength(1)
  })

  it("treats undefined stored speed as 'normal' so a first normal message does not restart", { timeout: 15000 }, async () => {
    // Simulates a session created before this feature (no persisted speed).
    const process = new ClaudeCodeProcess({
      sessionId: 'test-speed-5',
      workingDirectory: '/tmp',
      // speed intentionally omitted
    })

    await process.start()
    expect(calls).toHaveLength(1)

    await process.sendMessage('hello', undefined, { speed: 'normal' })
    expect(calls).toHaveLength(1)

    await process.sendMessage('hello again', undefined, { speed: 'slow' })
    expect(calls).toHaveLength(2)
    expect(speedHeaderOf(calls[1])).toBe('X-Superagent-Speed: slow')
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

describe('ClaudeCodeProcess model context windows', () => {
  beforeEach(() => {
    calls.length = 0
    setModelCalls.length = 0
  })

  const windows = { 'grok-4.6': 500_000, 'gpt-5.5': 1_050_000 }
  const maxContextOf = (call: MockQueryCall): string | undefined =>
    (call.options.env as Record<string, string | undefined>).CLAUDE_CODE_MAX_CONTEXT_TOKENS

  it('sets CLAUDE_CODE_MAX_CONTEXT_TOKENS from the catalog map for the session model', async () => {
    const process = new ClaudeCodeProcess({
      sessionId: 'test-ctx-1',
      workingDirectory: '/tmp',
      model: 'grok-4.6',
      modelContextWindows: windows,
    })

    await process.start()
    expect(calls).toHaveLength(1)
    expect(maxContextOf(calls[0])).toBe('500000')
  })

  it('leaves the env var unset for a model without a catalog window', async () => {
    const process = new ClaudeCodeProcess({
      sessionId: 'test-ctx-2',
      workingDirectory: '/tmp',
      model: 'claude-sonnet-4-6',
      modelContextWindows: windows,
    })

    await process.start()
    expect(calls).toHaveLength(1)
    expect(maxContextOf(calls[0])).toBeUndefined()
  })

  it('lets a user-set custom env var win over the catalog value', async () => {
    const process = new ClaudeCodeProcess({
      sessionId: 'test-ctx-3',
      workingDirectory: '/tmp',
      model: 'grok-4.6',
      modelContextWindows: windows,
      customEnvVars: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '123456' },
    })

    await process.start()
    expect(calls).toHaveLength(1)
    expect(maxContextOf(calls[0])).toBe('123456')
  })

  it('restarts the query (not setModel) when a model switch changes the window', { timeout: 15000 }, async () => {
    const process = new ClaudeCodeProcess({
      sessionId: 'test-ctx-4',
      workingDirectory: '/tmp',
      model: 'claude-sonnet-4-6',
      modelContextWindows: windows,
    })

    await process.start()
    expect(calls).toHaveLength(1)
    expect(maxContextOf(calls[0])).toBeUndefined()

    // claude → grok changes the window (unset → 500k); dynamic setModel would
    // leave the new model running against the old env, so it must re-query.
    await process.sendMessage('hello', undefined, { model: 'grok-4.6' })

    expect(setModelCalls).toHaveLength(0)
    expect(calls).toHaveLength(2)
    expect(calls[1].options.model).toBe('grok-4.6')
    expect(maxContextOf(calls[1])).toBe('500000')
  })

  it('still switches dynamically when both models share a window', async () => {
    const process = new ClaudeCodeProcess({
      sessionId: 'test-ctx-5',
      workingDirectory: '/tmp',
      model: 'claude-sonnet-4-6',
      modelContextWindows: windows,
    })

    await process.start()
    expect(calls).toHaveLength(1)

    // Neither claude id has a catalog window — no env change, setModel is fine.
    await process.sendMessage('hello', undefined, { model: 'claude-opus-4-7' })

    expect(calls).toHaveLength(1)
    expect(setModelCalls).toEqual(['claude-opus-4-7'])
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

describe('ClaudeCodeProcess agent-browser Bash hook', () => {
  beforeEach(() => {
    calls.length = 0
  })

  it('adds a warning without denying direct agent-browser commands', async () => {
    const process = new ClaudeCodeProcess({
      sessionId: 'test-agent-browser-hook',
      workingDirectory: '/tmp',
    })

    await process.start()
    const hooks = calls[0].options.hooks as {
      PreToolUse: Array<{
        matcher: string
        hooks: Array<(input: unknown) => Promise<Record<string, unknown>>>
      }>
    }
    const bashHook = hooks.PreToolUse.find((hook) => hook.matcher === 'Bash')
    expect(bashHook).toBeDefined()

    const directResult = await bashHook!.hooks[0]({
      tool_name: 'Bash',
      tool_input: { command: 'agent-browser open https://example.com' },
    })
    const discoveryResult = await bashHook!.hooks[0]({
      tool_name: 'Bash',
      tool_input: { command: 'which agent-browser; agent-browser --help' },
    })
    for (const result of [directResult, discoveryResult]) {
      expect(result).toMatchObject({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          additionalContext: expect.stringContaining('STRONG WARNING'),
        },
      })
      expect(result).not.toHaveProperty('hookSpecificOutput.permissionDecision')
    }
  })

  it('does not add context to ordinary Bash commands', async () => {
    const process = new ClaudeCodeProcess({
      sessionId: 'test-ordinary-bash-hook',
      workingDirectory: '/tmp',
    })

    await process.start()
    const hooks = calls[0].options.hooks as {
      PreToolUse: Array<{
        matcher: string
        hooks: Array<(input: unknown) => Promise<Record<string, unknown>>>
      }>
    }
    const bashHook = hooks.PreToolUse.find((hook) => hook.matcher === 'Bash')!
    await expect(bashHook.hooks[0]({
      tool_name: 'Bash',
      tool_input: { command: 'rg browser src' },
    })).resolves.toEqual({})
  })
})

describe('ClaudeCodeProcess static tool bans', () => {
  beforeEach(() => {
    calls.length = 0
  })

  it('blocks DesignSync globally', async () => {
    const process = new ClaudeCodeProcess({
      sessionId: 'test-designsync-disabled',
      workingDirectory: '/tmp',
    })

    await process.start()
    expect(calls).toHaveLength(1)
    const disallowed = calls[0].options.disallowedTools as string[]
    expect(disallowed).toContain('DesignSync')
  })
})

describe('ClaudeCodeProcess dashboard browser tools', () => {
  beforeEach(() => {
    calls.length = 0
  })

  it('lets the dashboard builder open and validate container-local dashboards', async () => {
    const process = new ClaudeCodeProcess({
      sessionId: 'test-dashboard-browser-tools',
      workingDirectory: '/tmp',
    })

    await process.start()
    const agents = calls[0].options.agents as Record<string, { tools: string[] }>
    const tools = agents['dashboard-builder'].tools
    expect(tools).toContain('mcp__browser__browser_open')
    expect(tools).toContain('mcp__browser__browser_get_state')
    expect(tools).toContain('mcp__browser__browser_click')
    expect(tools).toContain('mcp__browser__browser_close')
  })
})
