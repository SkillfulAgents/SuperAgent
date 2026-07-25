import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type MockQueryCall = { options: Record<string, unknown> }
const calls: MockQueryCall[] = []

vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  function makeQuery(args: { options: Record<string, unknown> }) {
    const abortController = args.options.abortController as AbortController
    let resolvePending:
      | ((result: IteratorResult<never>) => void)
      | undefined
    const finish = () => {
      resolvePending?.({ value: undefined, done: true })
      resolvePending = undefined
    }
    abortController.signal.addEventListener('abort', finish, { once: true })

    const iterator: AsyncIterableIterator<never> & {
      interrupt: () => Promise<void>
      setModel: () => Promise<void>
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
        return Promise.resolve({ value: undefined, done: true })
      },
      throw(error?: unknown) {
        return Promise.reject(error)
      },
      interrupt() {
        return Promise.resolve()
      },
      setModel() {
        return Promise.resolve()
      },
    }
    return iterator
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
  createAgentsMcpServer: () => ({}),
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

describe('ClaudeCodeProcess runtime connection handling', () => {
  let originalRemoteMcps: string | undefined
  let originalConnectedAccounts: string | undefined
  let claudeProcess: ClaudeCodeProcess | undefined

  beforeEach(() => {
    calls.length = 0
    originalRemoteMcps = process.env.REMOTE_MCPS
    originalConnectedAccounts = process.env.CONNECTED_ACCOUNTS
    delete process.env.REMOTE_MCPS
    delete process.env.CONNECTED_ACCOUNTS
  })

  afterEach(async () => {
    await claudeProcess?.stop()
    if (originalRemoteMcps === undefined) {
      delete process.env.REMOTE_MCPS
    } else {
      process.env.REMOTE_MCPS = originalRemoteMcps
    }
    if (originalConnectedAccounts === undefined) {
      delete process.env.CONNECTED_ACCOUNTS
    } else {
      process.env.CONNECTED_ACCOUNTS = originalConnectedAccounts
    }
  })

  it('rebuilds a live query when Agent Settings changes MCPs or connected accounts', async () => {
    claudeProcess = new ClaudeCodeProcess({
      sessionId: 'test-runtime-connection-refresh',
      workingDirectory: '/tmp',
    })

    await claudeProcess.start()
    expect(calls).toHaveLength(1)
    expect(calls[0].options.mcpServers).not.toHaveProperty('team_calendar')

    process.env.REMOTE_MCPS = JSON.stringify([
      {
        id: 'mcp-calendar',
        name: 'Team Calendar',
        proxyUrl: 'http://host.test/api/mcp-proxy/test-agent/mcp-calendar',
        tools: [{ name: 'list_events' }],
      },
    ])

    await claudeProcess.sendMessage('List today’s events')

    expect(calls).toHaveLength(2)
    expect(calls[1].options.mcpServers).toMatchObject({
      team_calendar: {
        type: 'http',
        url: 'http://host.test/api/mcp-proxy/test-agent/mcp-calendar',
      },
    })
    expect(calls[1].options.allowedTools).toContain('mcp__team_calendar__*')
    expect(calls[1].options.systemPrompt).toContain('Team Calendar')
    expect(calls[1].options.systemPrompt).toContain('list_events')

    process.env.REMOTE_MCPS = '[]'
    await claudeProcess.sendMessage('Continue without the calendar')

    expect(calls).toHaveLength(3)
    expect(calls[2].options.mcpServers).not.toHaveProperty('team_calendar')
    expect(calls[2].options.allowedTools).not.toContain('mcp__team_calendar__*')
    expect(calls[2].options.systemPrompt).not.toContain('Team Calendar')

    process.env.CONNECTED_ACCOUNTS = JSON.stringify({
      gmail: [{ name: 'Work Gmail', id: 'account-gmail' }],
    })
    await claudeProcess.sendMessage('Check the connected Gmail account')

    expect(calls).toHaveLength(4)
    expect(calls[3].options.systemPrompt).toContain('Work Gmail')
    expect(calls[3].options.systemPrompt).toContain('account-gmail')

    process.env.CONNECTED_ACCOUNTS = '{}'
    await claudeProcess.sendMessage('Continue without Gmail')

    expect(calls).toHaveLength(5)
    expect(calls[4].options.systemPrompt).not.toContain('Work Gmail')
  })

  it('treats unset and serialized empty projections as equivalent', async () => {
    claudeProcess = new ClaudeCodeProcess({
      sessionId: 'test-empty-runtime-connections',
      workingDirectory: '/tmp',
    })

    await claudeProcess.start()
    process.env.REMOTE_MCPS = '[]'
    process.env.CONNECTED_ACCOUNTS = '{}'

    await claudeProcess.sendMessage('Continue without connections')

    expect(calls).toHaveLength(1)
  })
})
