import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { inputManager } from '../input-manager'

const mockAddRemoteMcpServer = vi.fn()
vi.mock('../claude-code', () => ({
  getCurrentProcess: () => ({
    addRemoteMcpServer: (...args: unknown[]) => mockAddRemoteMcpServer(...args),
  }),
}))

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
    const { requestRemoteMcpTool } = await import('./request-remote-mcp')
    const handler = (requestRemoteMcpTool as any).handler
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
})
