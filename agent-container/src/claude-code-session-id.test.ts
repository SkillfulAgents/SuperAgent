/**
 * The session id must be known to the process's tool calls from the very
 * first one: /opt/gamut/bin/list-sessions.py and read-session.py read
 * GAMUT_SESSION_ID to keep the agent from "finding" the conversation it is
 * currently in and reading it back as prior work.
 *
 * That only holds if a fresh session runs under the id we already hold
 * (passed to the SDK as `sessionId`) rather than one the CLI mints at init —
 * the env is fixed when query() is created, before init reports anything.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

type MockQueryCall = { options: Record<string, unknown> }
const calls: MockQueryCall[] = []

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

vi.mock('./mcp-server', () => ({
  createUserInputMcpServer: () => ({}),
  createBrowserMcpServer: () => ({}),
  createComputerUseMcpServer: () => ({}),
  createDashboardsMcpServer: () => ({}),
  createWidgetsMcpServer: () => ({}),
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
  HUMAN_INPUT_TTL_MS: 24 * 60 * 60 * 1000,
}))

import { ClaudeCodeProcess } from './claude-code'

describe('ClaudeCodeProcess session id exposure', () => {
  beforeEach(() => {
    calls.length = 0
  })

  it('runs a fresh session under the pre-generated id and exports it as GAMUT_SESSION_ID', async () => {
    const process = new ClaudeCodeProcess({
      sessionId: '11111111-2222-4333-8444-555555555555',
      workingDirectory: '/tmp',
    })
    await process.start()

    expect(calls).toHaveLength(1)
    const options = calls[0].options
    expect(options.sessionId).toBe('11111111-2222-4333-8444-555555555555')
    expect(options.resume).toBeUndefined()
    expect((options.env as Record<string, string>).GAMUT_SESSION_ID).toBe(
      '11111111-2222-4333-8444-555555555555'
    )
  })

  it('resumes under the stored Claude id, never both `sessionId` and `resume`', async () => {
    const process = new ClaudeCodeProcess({
      sessionId: 'host-id',
      claudeSessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      workingDirectory: '/tmp',
    })
    await process.start()

    const options = calls[0].options
    expect(options.resume).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')
    expect(options.sessionId).toBeUndefined()
    expect((options.env as Record<string, string>).GAMUT_SESSION_ID).toBe(
      'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    )
  })

  it('does not let an agent-set custom env var mask the real id', async () => {
    const process = new ClaudeCodeProcess({
      sessionId: 'real-id',
      workingDirectory: '/tmp',
      customEnvVars: { GAMUT_SESSION_ID: 'spoofed' },
    })
    await process.start()

    expect((calls[0].options.env as Record<string, string>).GAMUT_SESSION_ID).toBe('real-id')
  })
})
