import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type MockQueryCall = { options: Record<string, unknown> }
type MockMcpStatus = { name: string; status: string }
type MockSetServersResult = { added: string[]; removed: string[]; errors: Record<string, string> }
const calls: MockQueryCall[] = []

// Per-test override for the mcpServerStatus() control request. Left null, every
// server configured on the most recent query reports 'connected' immediately, so
// tests that are not about the handshake gate never wait on it.
let mcpServerStatusImpl: (() => Promise<MockMcpStatus[]>) | null = null
let mcpServerStatusCalls = 0

// Per-test override for the setMcpServers() control request. Left null, the
// call succeeds and reports every named server as added. The SDK 0.3.257
// behaviour this mirrors: the map is a full replace, already-registered SDK
// servers are left alone, and the result names added/removed/errored servers.
let setMcpServersImpl: ((servers: Record<string, unknown>) => Promise<MockSetServersResult>) | null = null
const setMcpServersCalls: Array<Record<string, unknown>> = []

const UNSUPPORTED = async () => {
  throw new Error('control request not supported')
}

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
      setMcpServers: (servers: Record<string, unknown>) => Promise<MockSetServersResult>
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
      setMcpServers(servers) {
        setMcpServersCalls.push(servers)
        return (
          setMcpServersImpl ??
          (async (s: Record<string, unknown>) => ({ added: Object.keys(s), removed: [], errors: {} }))
        )(servers)
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
  createUserInputMcpServer: () => ({ type: 'sdk', name: 'user-input' }),
  createBrowserMcpServer: () => ({ type: 'sdk', name: 'browser' }),
  createComputerUseMcpServer: () => ({ type: 'sdk', name: 'computer-use' }),
  createDashboardsMcpServer: () => ({ type: 'sdk', name: 'dashboards' }),
  createAgentsMcpServer: () => ({ type: 'sdk', name: 'agents' }),
  createChatMcpServer: () => ({ type: 'sdk', name: 'chat' }),
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

// The in-process servers every query carries. A dynamic set that omits any of
// them would make the SDK disconnect it — the user-input server in particular
// is the one the request_remote_mcp tool itself runs inside.
const SDK_SERVER_NAMES = ['user-input', 'browser', 'dashboards', 'agents', 'chat']

function useRuntimeEnv() {
  let originalRemoteMcps: string | undefined
  let originalConnectedAccounts: string | undefined

  beforeEach(() => {
    calls.length = 0
    setMcpServersCalls.length = 0
    setMcpServersImpl = null
    mcpServerStatusImpl = null
    mcpServerStatusCalls = 0
    originalRemoteMcps = process.env.REMOTE_MCPS
    originalConnectedAccounts = process.env.CONNECTED_ACCOUNTS
    delete process.env.REMOTE_MCPS
    delete process.env.CONNECTED_ACCOUNTS
  })

  afterEach(() => {
    if (originalRemoteMcps === undefined) delete process.env.REMOTE_MCPS
    else process.env.REMOTE_MCPS = originalRemoteMcps
    if (originalConnectedAccounts === undefined) delete process.env.CONNECTED_ACCOUNTS
    else process.env.CONNECTED_ACCOUNTS = originalConnectedAccounts
  })
}

describe('ClaudeCodeProcess runtime connection handling', () => {
  let claudeProcess: ClaudeCodeProcess | undefined
  useRuntimeEnv()

  async function startProcess(sessionId: string): Promise<ClaudeCodeProcess> {
    claudeProcess = new ClaudeCodeProcess({ sessionId, workingDirectory: '/tmp' })
    await claudeProcess.start()
    return claudeProcess
  }

  afterEach(async () => {
    await claudeProcess?.stop()
    claudeProcess = undefined
  })

  it('applies a remote MCP change to the live query in place, without a re-query', async () => {
    const claude = await startProcess('test-runtime-mcp-hot-apply')
    expect(calls).toHaveLength(1)
    expect(calls[0].options.mcpServers).not.toHaveProperty('team_calendar')

    process.env.REMOTE_MCPS = CALENDAR
    await claude.sendMessage('List today’s events')

    // Same query, one dynamic set carrying the FULL map: every in-process
    // server plus the new remote one.
    expect(calls).toHaveLength(1)
    expect(setMcpServersCalls).toHaveLength(1)
    for (const name of SDK_SERVER_NAMES) expect(setMcpServersCalls[0]).toHaveProperty(name)
    expect(setMcpServersCalls[0]).toMatchObject({
      team_calendar: {
        type: 'http',
        url: 'http://host.test/api/mcp-proxy/test-agent/mcp-calendar',
      },
    })
    // setMcpServers() only returns once the server has settled, so the
    // handshake gate (a re-query concern) never polls.
    expect(mcpServerStatusCalls).toBe(0)

    // The live query now matches the projection: an unchanged follow-up
    // neither re-applies nor re-queries.
    await claude.sendMessage('And tomorrow’s?')
    expect(calls).toHaveLength(1)
    expect(setMcpServersCalls).toHaveLength(1)

    // Removing the server is the same replace, minus the entry.
    process.env.REMOTE_MCPS = '[]'
    await claude.sendMessage('Continue without the calendar')
    expect(calls).toHaveLength(1)
    expect(setMcpServersCalls).toHaveLength(2)
    expect(setMcpServersCalls[1]).not.toHaveProperty('team_calendar')
    for (const name of SDK_SERVER_NAMES) expect(setMcpServersCalls[1]).toHaveProperty(name)
  })

  it('carries the refreshed prompt and tool patterns into the next query creation', async () => {
    const claude = await startProcess('test-runtime-mcp-prompt-refresh')

    process.env.REMOTE_MCPS = CALENDAR
    await claude.sendMessage('List today’s events')
    expect(calls).toHaveLength(1)

    // The live query keeps its prompt; an unrelated re-query (effort change)
    // must be built from the refreshed projection, not the boot-time one.
    await claude.sendMessage('Now think harder', undefined, { effort: 'max' })
    expect(calls).toHaveLength(2)
    expect(calls[1].options.mcpServers).toHaveProperty('team_calendar')
    expect(calls[1].options.allowedTools).toContain('mcp__team_calendar__*')
    expect(calls[1].options.systemPrompt).toContain('Team Calendar')
    expect(calls[1].options.systemPrompt).toContain('list_events')
    // The rebuild re-read the env itself — no dynamic set on top of it.
    expect(setMcpServersCalls).toHaveLength(1)
  })

  it('rides a pending remote MCP change along with a re-query instead of applying it twice', async () => {
    const claude = await startProcess('test-runtime-mcp-with-requery')

    process.env.REMOTE_MCPS = CALENDAR
    await claude.sendMessage('List today’s events', undefined, { effort: 'max' })

    expect(calls).toHaveLength(2)
    expect(calls[1].options.mcpServers).toHaveProperty('team_calendar')
    expect(setMcpServersCalls).toHaveLength(0)
    // A rebuilt query races its own handshake, so this path still gates.
    expect(mcpServerStatusCalls).toBe(1)
  })

  it('falls back to a re-query when the CLI has no dynamic MCP support', async () => {
    const claude = await startProcess('test-runtime-mcp-fallback')
    setMcpServersImpl = UNSUPPORTED

    process.env.REMOTE_MCPS = CALENDAR
    await claude.sendMessage('List today’s events')

    expect(setMcpServersCalls).toHaveLength(1)
    expect(calls).toHaveLength(2)
    expect(calls[1].options.mcpServers).toMatchObject({
      team_calendar: { type: 'http' },
    })
    expect(calls[1].options.systemPrompt).toContain('Team Calendar')
    expect(mcpServerStatusCalls).toBe(1)
  })

  it('rebuilds a live query when Agent Settings changes connected accounts', async () => {
    const claude = await startProcess('test-runtime-connection-refresh')
    expect(calls).toHaveLength(1)

    process.env.CONNECTED_ACCOUNTS = JSON.stringify({
      gmail: [{ name: 'Work Gmail', id: 'account-gmail', status: 'expired' }],
    })
    await claude.sendMessage('Check the connected Gmail account')

    // Connected accounts reach the model through the prompt alone, and the
    // prompt is baked at query creation — so this one is still a re-query.
    expect(calls).toHaveLength(2)
    expect(setMcpServersCalls).toHaveLength(0)
    expect(calls[1].options.systemPrompt).toContain('Work Gmail')
    expect(calls[1].options.systemPrompt).toContain('account-gmail')
    expect(calls[1].options.systemPrompt).toContain('status: `expired`')
    expect(calls[1].options.systemPrompt).toContain('Make the intended proxy call')
    expect(calls[1].options.systemPrompt).toContain('Do NOT report them as missing')

    process.env.CONNECTED_ACCOUNTS = '{}'
    await claude.sendMessage('Continue without Gmail')

    expect(calls).toHaveLength(3)
    expect(calls[2].options.systemPrompt).not.toContain('Work Gmail')
  })

  it('treats unset and serialized empty projections as equivalent', async () => {
    const claude = await startProcess('test-empty-runtime-connections')
    process.env.REMOTE_MCPS = '[]'
    process.env.CONNECTED_ACCOUNTS = '{}'

    await claude.sendMessage('Continue without connections')

    expect(calls).toHaveLength(1)
    expect(setMcpServersCalls).toHaveLength(0)
  })
})

describe('ClaudeCodeProcess.addRemoteMcpServer', () => {
  let claudeProcess: ClaudeCodeProcess | undefined
  useRuntimeEnv()

  async function startProcess(sessionId: string): Promise<ClaudeCodeProcess> {
    claudeProcess = new ClaudeCodeProcess({ sessionId, workingDirectory: '/tmp' })
    await claudeProcess.start()
    return claudeProcess
  }

  afterEach(async () => {
    await claudeProcess?.stop()
    claudeProcess = undefined
  })

  it('hot-adds the approved server to the live query and resolves once it is connected', async () => {
    const claude = await startProcess('test-add-mcp-hot')
    // The host writes the projection before resolving the approval.
    process.env.REMOTE_MCPS = CALENDAR

    await claude.addRemoteMcpServer('Team Calendar')

    // No interrupt, no re-query: the tool result lands in the same turn.
    expect(calls).toHaveLength(1)
    expect(setMcpServersCalls).toHaveLength(1)
    expect(setMcpServersCalls[0]).toHaveProperty('team_calendar')
    for (const name of SDK_SERVER_NAMES) expect(setMcpServersCalls[0]).toHaveProperty(name)

    // The live query is in sync with the projection, so the user's next
    // message does not re-apply the change or restart anything.
    await claude.sendMessage('Great, list today’s events')
    expect(calls).toHaveLength(1)
    expect(setMcpServersCalls).toHaveLength(1)
  })

  it('rejects when the server registered but failed to connect', async () => {
    const claude = await startProcess('test-add-mcp-connect-error')
    process.env.REMOTE_MCPS = CALENDAR
    setMcpServersImpl = async () => ({
      added: [],
      removed: [],
      errors: { team_calendar: 'fetch failed: ECONNREFUSED' },
    })

    await expect(claude.addRemoteMcpServer('Team Calendar')).rejects.toThrow(
      /team_calendar.*failed to connect.*ECONNREFUSED/,
    )
    expect(calls).toHaveLength(1)
  })

  it('falls back to interrupt + continuation when the CLI rejects the dynamic set', async () => {
    const claude = await startProcess('test-add-mcp-fallback')
    process.env.REMOTE_MCPS = CALENDAR
    setMcpServersImpl = UNSUPPORTED
    const sendSpy = vi.spyOn(claude, 'sendMessage')

    await claude.addRemoteMcpServer('Team Calendar')
    // The legacy path is deferred so the tool result reaches the CLI first.
    await vi.waitFor(() => expect(calls).toHaveLength(2))

    expect(calls[1].options.mcpServers).toHaveProperty('team_calendar')
    expect(sendSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^\[SYSTEM\] The remote MCP server "Team Calendar" has been fully registered/),
    )
  })
})

describe('ClaudeCodeProcess remote MCP handshake gate', () => {
  let claudeProcess: ClaudeCodeProcess | undefined
  useRuntimeEnv()

  async function startProcess(sessionId: string): Promise<ClaudeCodeProcess> {
    claudeProcess = new ClaudeCodeProcess({ sessionId, workingDirectory: '/tmp' })
    await claudeProcess.start()
    return claudeProcess
  }

  beforeEach(() => {
    // The gate only guards a REBUILT query (cold restart or re-query), whose
    // handshake runs concurrently with the first turn. With dynamic MCP
    // support the live-query path never rebuilds, so these cases pin the
    // CLI down to the fallback to exercise it.
    setMcpServersImpl = UNSUPPORTED
  })

  afterEach(async () => {
    await claudeProcess?.stop()
    claudeProcess = undefined
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
