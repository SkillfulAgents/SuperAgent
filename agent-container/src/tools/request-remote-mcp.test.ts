import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { inputManager } from '../input-manager'

// The tool is built against its owning process, so the test supplies one
// rather than stubbing a module global.
const mockAddRemoteMcpServer = vi.fn()
const owningProcess = {
  addRemoteMcpServer: (...args: unknown[]) => mockAddRemoteMcpServer(...args),
}

const GRANOLA_MCP = {
  id: 'mcp-granola-1',
  name: 'Granola',
  proxyUrl: 'http://host/api/mcp-proxy/agent/mcp-granola-1',
  tools: [{ name: 'list_meetings' }, { name: 'get_meetings' }],
}

describe('requestRemoteMcpTool', () => {
  let originalRemoteMcps: string | undefined

  beforeEach(() => {
    vi.clearAllMocks()
    originalRemoteMcps = process.env.REMOTE_MCPS
  })

  afterEach(() => {
    if (originalRemoteMcps === undefined) {
      delete process.env.REMOTE_MCPS
    } else {
      process.env.REMOTE_MCPS = originalRemoteMcps
    }
  })

  async function invokeTool() {
    const { createRequestRemoteMcpTool } = await import('./request-remote-mcp')
    const handler = (createRequestRemoteMcpTool(() => owningProcess) as any).handler
    return handler({ url: 'https://mcp.granola.ai/mcp', name: 'Granola', authHint: 'oauth' })
  }

  it('reports registered tools when the resolved server is in REMOTE_MCPS', async () => {
    process.env.REMOTE_MCPS = JSON.stringify([GRANOLA_MCP])
    const toolUseId = `mcp-test-${Date.now()}-1`
    inputManager.setCurrentToolUseId(toolUseId)
    inputManager.resolve(toolUseId, GRANOLA_MCP.id)

    const result = await invokeTool()

    expect(result.isError).toBeUndefined()
    expect(result.content[0].text).toContain('MCP Server registered as: granola')
    expect(result.content[0].text).toContain('mcp__granola__list_meetings')
    expect(mockAddRemoteMcpServer).toHaveBeenCalledWith('Granola')
  })

  it('returns an explicit error when the resolved server is missing from REMOTE_MCPS', async () => {
    // The host filters non-active servers out of REMOTE_MCPS — a stale server
    // can be approved yet never registered. The model must not be told
    // "granted" in that case.
    process.env.REMOTE_MCPS = JSON.stringify([])
    const toolUseId = `mcp-test-${Date.now()}-2`
    inputManager.setCurrentToolUseId(toolUseId)
    inputManager.resolve(toolUseId, GRANOLA_MCP.id)

    const result = await invokeTool()

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('NOT registered')
    expect(result.content[0].text).toContain('re-authenticated')
    expect(result.content[0].text).not.toContain('has been granted')
    expect(mockAddRemoteMcpServer).not.toHaveBeenCalled()
  })

  it('returns an explicit error when REMOTE_MCPS is unset after approval', async () => {
    delete process.env.REMOTE_MCPS
    const toolUseId = `mcp-test-${Date.now()}-3`
    inputManager.setCurrentToolUseId(toolUseId)
    inputManager.resolve(toolUseId, GRANOLA_MCP.id)

    const result = await invokeTool()

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('NOT registered')
    expect(mockAddRemoteMcpServer).not.toHaveBeenCalled()
  })

  it('returns declined message when the request is rejected', async () => {
    const toolUseId = `mcp-test-${Date.now()}-4`
    inputManager.setCurrentToolUseId(toolUseId)
    inputManager.reject(toolUseId, 'User declined to provide MCP access')

    const result = await invokeTool()

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('declined')
  })


  // Regression: the injection target used to come from a module global set in
  // the ClaudeCodeProcess constructor, so the most recently CONSTRUCTED process
  // won. Once the container pre-warms a process for the next session, that
  // global points at the parked process from the moment a session starts — the
  // approved MCP would be injected into a query nobody is talking to, and the
  // asking session would never see the tools.
  it('injects into the owning process, never the pre-warmed one built after it', async () => {
    process.env.REMOTE_MCPS = JSON.stringify([GRANOLA_MCP])
    const parkedInjections: string[] = []
    const { createRequestRemoteMcpTool } = await import('./request-remote-mcp')
    // Built for the live session; the parked process is created afterwards.
    const tool = createRequestRemoteMcpTool(() => owningProcess) as any
    const parked = { addRemoteMcpServer: (name: string) => parkedInjections.push(name) }
    void parked

    const toolUseId = `mcp-test-${Date.now()}-5`
    inputManager.setCurrentToolUseId(toolUseId)
    inputManager.resolve(toolUseId, GRANOLA_MCP.id)
    await tool.handler({ url: 'https://mcp.granola.ai/mcp', name: 'Granola' })

    expect(mockAddRemoteMcpServer).toHaveBeenCalledWith(GRANOLA_MCP.name)
    expect(parkedInjections).toEqual([])
  })

  // The owning process object is replaced on interrupt/restart, so the target
  // has to be read when the tool runs rather than captured at build time.
  it('resolves the owning process at call time', async () => {
    process.env.REMOTE_MCPS = JSON.stringify([GRANOLA_MCP])
    const injections: string[] = []
    let current = { addRemoteMcpServer: (_: string) => { throw new Error('stale process was used') } }
    const { createRequestRemoteMcpTool } = await import('./request-remote-mcp')
    const tool = createRequestRemoteMcpTool(() => current) as any
    current = { addRemoteMcpServer: (name: string) => injections.push(name) }

    const toolUseId = `mcp-test-${Date.now()}-6`
    inputManager.setCurrentToolUseId(toolUseId)
    inputManager.resolve(toolUseId, GRANOLA_MCP.id)
    await tool.handler({ url: 'https://mcp.granola.ai/mcp', name: 'Granola' })

    expect(injections).toEqual([GRANOLA_MCP.name])
  })
})
