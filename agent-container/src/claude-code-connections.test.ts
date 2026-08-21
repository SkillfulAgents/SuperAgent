import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type MockQueryCall = { options: Record<string, unknown> }
type MockMcpStatus = { name: string; status: string }
const calls: MockQueryCall[] = []

// Per-test override for the mcpServerStatus() control request. Left null, every
// server configured on the most recent query reports 'connected' immediately, so
// tests that are not about the handshake gate never wait on it.
let mcpServerStatusImpl: (() => Promise<MockMcpStatus[]>) | null = null
let mcpServerStatusCalls = 0

function allConnected(): MockMcpStatus[] {
  const servers = (calls[calls.length - 1]?.options.mcpServers ?? {}) as Record<string, unknown>
  return Object.keys(servers).map((name) => ({ name, status: 'connected' }))
}

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
      mcpServerStatus: () => Promise<MockMcpStatus[]>
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
      mcpServerStatus() {
        mcpServerStatusCalls++
        return (mcpServerStatusImpl ?? (async () => allConnected()))()
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
  createBrainMcpServer: () => ({}),
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
    mcpServerStatusImpl = null
    mcpServerStatusCalls = 0
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
      gmail: [{ name: 'Work Gmail', id: 'account-gmail', status: 'expired' }],
    })
    await claudeProcess.sendMessage('Check the connected Gmail account')

    expect(calls).toHaveLength(4)
    expect(calls[3].options.systemPrompt).toContain('Work Gmail')
    expect(calls[3].options.systemPrompt).toContain('account-gmail')
    expect(calls[3].options.systemPrompt).toContain('status: `expired`')
    expect(calls[3].options.systemPrompt).toContain('Make the intended proxy call')
    expect(calls[3].options.systemPrompt).toContain('Do NOT report them as missing')

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

describe('ClaudeCodeProcess Team Brain MCP gate', () => {
  let claudeProcess: ClaudeCodeProcess | undefined

  beforeEach(() => {
    calls.length = 0
    mcpServerStatusImpl = null
    mcpServerStatusCalls = 0
    delete process.env.REMOTE_MCPS
    delete process.env.CONNECTED_ACCOUNTS
  })

  afterEach(async () => {
    await claudeProcess?.stop()
    claudeProcess = undefined
  })

  it('registers the brain server only when the workspace flag is on', async () => {
    claudeProcess = new ClaudeCodeProcess({
      sessionId: 'test-brain-gate-off',
      workingDirectory: '/tmp',
    })
    await claudeProcess.start()
    expect(calls[calls.length - 1].options.mcpServers).not.toHaveProperty('brain')
    await claudeProcess.stop()
    claudeProcess = undefined

    claudeProcess = new ClaudeCodeProcess({
      sessionId: 'test-brain-gate-on',
      workingDirectory: '/tmp',
      teamBrain: true,
    })
    await claudeProcess.start()
    expect(calls[calls.length - 1].options.mcpServers).toHaveProperty('brain')
    expect(calls[calls.length - 1].options.systemPrompt).toContain('## Team Brain')
  })
})

describe('ClaudeCodeProcess remote MCP handshake gate', () => {
  let originalRemoteMcps: string | undefined
  let originalConnectedAccounts: string | undefined
  let claudeProcess: ClaudeCodeProcess | undefined

  const CALENDAR = JSON.stringify([
    {
      id: 'mcp-calendar',
      name: 'Team Calendar',
      proxyUrl: 'http://host.test/api/mcp-proxy/test-agent/mcp-calendar',
      tools: [{ name: 'list_events' }],
    },
  ])

  const AUTH_REQUIRED_CALENDAR = JSON.stringify([
    {
      id: 'mcp-calendar',
      name: 'Team Calendar',
      status: 'auth_required',
      proxyUrl: 'http://host.test/api/mcp-proxy/test-agent/mcp-calendar',
      tools: [{ name: 'list_events' }],
    },
  ])

  async function startProcess(sessionId: string): Promise<ClaudeCodeProcess> {
    claudeProcess = new ClaudeCodeProcess({ sessionId, workingDirectory: '/tmp' })
    await claudeProcess.start()
    return claudeProcess
  }

  beforeEach(() => {
    calls.length = 0
    mcpServerStatusImpl = null
    mcpServerStatusCalls = 0
    originalRemoteMcps = process.env.REMOTE_MCPS
    originalConnectedAccounts = process.env.CONNECTED_ACCOUNTS
    delete process.env.REMOTE_MCPS
    delete process.env.CONNECTED_ACCOUNTS
  })

  afterEach(async () => {
    await claudeProcess?.stop()
    claudeProcess = undefined
    if (originalRemoteMcps === undefined) delete process.env.REMOTE_MCPS
    else process.env.REMOTE_MCPS = originalRemoteMcps
    if (originalConnectedAccounts === undefined) delete process.env.CONNECTED_ACCOUNTS
    else process.env.CONNECTED_ACCOUNTS = originalConnectedAccounts
  })

  it('holds the message until a newly connected server finishes its handshake', async () => {
    const claude = await startProcess('test-handshake-gate-waits')

    // Two polls report the SDK still connecting, the third reports it done.
    let poll = 0
    mcpServerStatusImpl = async () => [
      { name: 'team_calendar', status: ++poll < 3 ? 'pending' : 'connected' },
    ]

    process.env.REMOTE_MCPS = CALENDAR
    await claude.sendMessage('List today’s events')

    // The query was rebuilt AND the send waited through the pending polls
    // rather than delivering into a half-connected session.
    expect(calls).toHaveLength(2)
    expect(mcpServerStatusCalls).toBe(3)
  })

  it('does not restart or block ordinary messages for an assigned MCP that needs re-authentication', async () => {
    process.env.REMOTE_MCPS = AUTH_REQUIRED_CALENDAR
    const claude = await startProcess('test-handshake-gate-reauth')
    mcpServerStatusImpl = async () => [
      { name: 'team_calendar', status: 'pending' },
    ]

    await claude.sendMessage('Draft an unrelated note')

    expect(calls).toHaveLength(1)
    expect(mcpServerStatusCalls).toBe(0)
    expect(calls[0].options.mcpServers).toHaveProperty('team_calendar')
    expect(calls[0].options.systemPrompt).toContain('Do not report an assigned server as missing')
  })

  it('restarts for a newly projected auth-required MCP without waiting on its parked handshake', async () => {
    const claude = await startProcess('test-handshake-gate-new-reauth')
    mcpServerStatusImpl = async () => [
      { name: 'team_calendar', status: 'pending' },
    ]

    process.env.REMOTE_MCPS = AUTH_REQUIRED_CALENDAR
    await claude.sendMessage('Draft an unrelated note')

    expect(calls).toHaveLength(2)
    expect(mcpServerStatusCalls).toBe(0)
    expect(calls[1].options.mcpServers).toHaveProperty('team_calendar')
  })

  it('still waits for a new active MCP when another assigned MCP needs re-authentication', async () => {
    process.env.REMOTE_MCPS = AUTH_REQUIRED_CALENDAR
    const claude = await startProcess('test-handshake-gate-mixed')
    let poll = 0
    mcpServerStatusImpl = async () => [
      { name: 'team_calendar', status: 'pending' },
      { name: 'active_search', status: ++poll < 2 ? 'pending' : 'connected' },
    ]

    process.env.REMOTE_MCPS = JSON.stringify([
      ...JSON.parse(AUTH_REQUIRED_CALENDAR),
      {
        id: 'mcp-search',
        name: 'Active Search',
        status: 'active',
        proxyUrl: 'http://host/api/mcp-proxy/agent/mcp-search',
        tools: [{ name: 'search' }],
      },
    ])
    await claude.sendMessage('Search for the latest update')

    expect(calls).toHaveLength(2)
    expect(mcpServerStatusCalls).toBe(2)
  })

  it('does not wait on MCP servers from other setting scopes', async () => {
    const claude = await startProcess('test-handshake-gate-foreign')

    // createQuery passes settingSources ['user','project'], so the status list
    // carries servers this agent never configured. A slow one of those must not
    // hold up the user's turn.
    mcpServerStatusImpl = async () => [
      { name: 'team_calendar', status: 'connected' },
      { name: 'some-user-scoped-server', status: 'pending' },
    ]

    process.env.REMOTE_MCPS = CALENDAR
    await claude.sendMessage('List today’s events')

    expect(mcpServerStatusCalls).toBe(1)
  })

  it('stops waiting at a server that will never become connected', async () => {
    const claude = await startProcess('test-handshake-gate-failed')

    // 'failed' is terminal — polling to the timeout would just delay the turn.
    mcpServerStatusImpl = async () => [{ name: 'team_calendar', status: 'failed' }]

    process.env.REMOTE_MCPS = CALENDAR
    await claude.sendMessage('List today’s events')

    expect(mcpServerStatusCalls).toBe(1)
    expect(calls).toHaveLength(2)
  })

  it('delivers the message when the control channel is unavailable', async () => {
    const claude = await startProcess('test-handshake-gate-no-channel')

    // Older CLI without the control request, or a query already torn down.
    mcpServerStatusImpl = async () => {
      throw new Error('control request not supported')
    }

    process.env.REMOTE_MCPS = CALENDAR
    await claude.sendMessage('List today’s events')

    expect(mcpServerStatusCalls).toBe(1)
    expect(calls).toHaveLength(2)
  })

  it('skips the probe entirely when the change left no remote MCPs configured', async () => {
    const claude = await startProcess('test-handshake-gate-accounts-only')

    // A connected-account-only change still re-queries, but there is no remote
    // MCP handshake to wait on.
    process.env.CONNECTED_ACCOUNTS = JSON.stringify({
      gmail: [{ name: 'Work Gmail', id: 'account-gmail' }],
    })
    await claude.sendMessage('Check the connected Gmail account')

    expect(calls).toHaveLength(2)
    expect(mcpServerStatusCalls).toBe(0)
  })

  it('gives up after the timeout instead of blocking the turn forever', async () => {
    const claude = await startProcess('test-handshake-gate-timeout')
    process.env.REMOTE_MCPS = CALENDAR

    mcpServerStatusImpl = async () => [{ name: 'team_calendar', status: 'pending' }]
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // Exercised directly so the test does not sit out the production timeout.
    await (
      claude as unknown as { waitForRemoteMcpsReady(ms: number): Promise<void> }
    ).waitForRemoteMcpsReady(600)

    expect(mcpServerStatusCalls).toBeGreaterThan(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('still pending'))
    warn.mockRestore()
  })
})
