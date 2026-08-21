import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockSyncAgentSessionsAwaiting = vi.fn()

vi.mock('@shared/lib/container/message-persister', () => ({
  messagePersister: {
    syncAgentSessionsAwaiting: (...args: unknown[]) => mockSyncAgentSessionsAwaiting(...args),
  },
}))

import { MCP_REAUTH_TIMEOUT_MS, McpReauthManager } from './mcp-reauth-manager'
import { userInputRequestManager } from '@shared/lib/user-input/request-manager'

const DETAILS = {
  agentSlug: 'agent-1',
  mcpId: 'mcp-1',
  mcpName: 'Cal.com',
  authType: 'oauth' as const,
}

describe('McpReauthManager', () => {
  let manager: McpReauthManager

  beforeEach(() => {
    vi.useFakeTimers()
    userInputRequestManager.reset()
    mockSyncAgentSessionsAwaiting.mockReset()
    manager = new McpReauthManager()
  })

  afterEach(() => {
    manager.rejectAll()
    userInputRequestManager.reset()
    vi.useRealTimers()
  })

  it('registers an agent-scoped MCP re-auth envelope', () => {
    const promise = manager.requestReauth(DETAILS)
    const [request] = userInputRequestManager.getAgentScopedRequests('agent-1')

    expect(request).toMatchObject({
      kind: 'mcp_reauth_required',
      blocking: true,
      scope: { agentSlug: 'agent-1' },
      payload: {
        mcpId: 'mcp-1',
        mcpName: 'Cal.com',
        authType: 'oauth',
      },
    })
    expect((request.payload as Record<string, unknown>).proxyRequestId).toBe(request.id)

    manager.completeMcp('mcp-1')
    return expect(promise).resolves.toBeUndefined()
  })

  it('resumes every proxy request parked on the reconnected MCP', async () => {
    const first = manager.requestReauth(DETAILS)
    const second = manager.requestReauth({ ...DETAILS, agentSlug: 'agent-2' })
    const unrelated = manager.requestReauth({ ...DETAILS, mcpId: 'mcp-2' })

    expect(manager.completeMcp('mcp-1')).toBe(2)
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined])
    expect(userInputRequestManager.getOpenRequestsForStore('review')).toHaveLength(1)

    manager.completeMcp('mcp-2')
    await expect(unrelated).resolves.toBeUndefined()
  })

  it('deduplicates concurrent waits for one MCP into a single agent card', async () => {
    const first = manager.requestReauth(DETAILS)
    const second = manager.requestReauth(DETAILS)

    expect(userInputRequestManager.getAgentScopedRequests('agent-1')).toHaveLength(1)
    expect(manager.completeMcp('mcp-1')).toBe(2)
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined])
  })

  it('keeps the shared card open when only one concurrent MCP request aborts', async () => {
    const controller = new AbortController()
    const aborted = manager.requestReauth(DETAILS, controller.signal)
    const remaining = manager.requestReauth(DETAILS)
    const rejection = expect(aborted).rejects.toThrow('aborted')

    controller.abort()

    await rejection
    expect(userInputRequestManager.getAgentScopedRequests('agent-1')).toHaveLength(1)
    expect(manager.completeMcp('mcp-1')).toBe(1)
    await expect(remaining).resolves.toBeUndefined()
  })

  it('settles an abandoned request after the timeout', async () => {
    const promise = manager.requestReauth(DETAILS)
    const rejection = expect(promise).rejects.toThrow('timed out')

    await vi.advanceTimersByTimeAsync(MCP_REAUTH_TIMEOUT_MS)

    await rejection
    expect(userInputRequestManager.getOpenRequestsForStore('review')).toHaveLength(0)
    expect(userInputRequestManager.stats.recentResolutions.at(-1)?.outcome).toBe('timeout')
  })

  it('cancels the wait when the proxy request is aborted', async () => {
    const controller = new AbortController()
    const promise = manager.requestReauth(DETAILS, controller.signal)
    const rejection = expect(promise).rejects.toThrow('aborted')

    controller.abort()

    await rejection
    expect(userInputRequestManager.getOpenRequestsForStore('review')).toHaveLength(0)
  })
})
