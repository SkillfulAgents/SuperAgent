import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

import { MCP_REAUTH_TIMEOUT_MS, McpReauthManager } from './mcp-reauth-manager'
import { userInputRequestManager } from '@shared/lib/tools/requests/request-manager'
import {
  attachInMemoryAgentState,
  type InMemoryAgentStateDirectory,
} from '@shared/lib/agent-actor/testing/in-memory-agent-state'

const DETAILS = {
  agentSlug: 'agent-1',
  mcpId: 'mcp-1',
  mcpName: 'Cal.com',
  authType: 'oauth' as const,
}

describe('McpReauthManager', () => {
  let manager: McpReauthManager
  let agents: InMemoryAgentStateDirectory
  let syncAwaiting: Map<string, MockInstance<() => void>>

  beforeEach(() => {
    vi.useFakeTimers()
    // The waits live on the agents' actors; the manager under test routes to
    // them. Build the actors' stores in memory, attached the way the registry
    // attaches the real handles.
    agents = attachInMemoryAgentState()
    // A card opening or closing has the agent's sessions recompute their
    // waiting state: observed here, with no session to recompute.
    syncAwaiting = new Map(
      ['agent-1', 'agent-2'].map((slug) => [
        slug,
        vi.spyOn(agents.get(slug).sessions, 'syncAwaiting').mockImplementation(() => {}),
      ]),
    )
    manager = new McpReauthManager()
    manager.attachAgents(agents.pick((state) => state.mcpReauth))
    userInputRequestManager.reset()
  })

  afterEach(() => {
    agents.reset()
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
    expect(syncAwaiting.get('agent-1')).toHaveBeenCalledTimes(1)

    manager.completeMcp('agent-1', 'mcp-1')
    expect(syncAwaiting.get('agent-1')).toHaveBeenCalledTimes(2)
    expect(syncAwaiting.get('agent-2')).not.toHaveBeenCalled()
    return expect(promise).resolves.toEqual({ outcome: 'resumed' })
  })

  it('resumes each agent\'s proxy requests parked on the reconnected MCP', async () => {
    const first = manager.requestReauth(DETAILS)
    const second = manager.requestReauth({ ...DETAILS, agentSlug: 'agent-2' })
    const unrelated = manager.requestReauth({ ...DETAILS, mcpId: 'mcp-2' })

    // Agent by agent: each agent's own calls on it go on.
    expect(manager.completeMcp('agent-1', 'mcp-1')).toBe(1)
    expect(manager.completeMcp('agent-2', 'mcp-1')).toBe(1)
    await expect(Promise.all([first, second])).resolves.toEqual([{ outcome: 'resumed' }, { outcome: 'resumed' }])
    expect(userInputRequestManager.getOpenRequestsForStore('review')).toHaveLength(1)

    manager.completeMcp('agent-1', 'mcp-2')
    await expect(unrelated).resolves.toEqual({ outcome: 'resumed' })
  })

  it('deduplicates concurrent waits for one MCP into a single agent card', async () => {
    const first = manager.requestReauth(DETAILS)
    const second = manager.requestReauth(DETAILS)

    expect(userInputRequestManager.getAgentScopedRequests('agent-1')).toHaveLength(1)
    expect(manager.completeMcp('agent-1', 'mcp-1')).toBe(2)
    await expect(Promise.all([first, second])).resolves.toEqual([{ outcome: 'resumed' }, { outcome: 'resumed' }])
  })

  it('keeps the shared card open when only one concurrent MCP request aborts', async () => {
    const controller = new AbortController()
    const aborted = manager.requestReauth(DETAILS, controller.signal)
    const remaining = manager.requestReauth(DETAILS)
    const rejection = expect(aborted).resolves.toEqual({ outcome: 'withdrawn' })

    controller.abort()

    await rejection
    expect(userInputRequestManager.getAgentScopedRequests('agent-1')).toHaveLength(1)
    expect(manager.completeMcp('agent-1', 'mcp-1')).toBe(1)
    await expect(remaining).resolves.toEqual({ outcome: 'resumed' })
  })

  it('settles an abandoned request after the timeout', async () => {
    const promise = manager.requestReauth(DETAILS)
    const rejection = expect(promise).resolves.toEqual({ outcome: 'timeout' })

    await vi.advanceTimersByTimeAsync(MCP_REAUTH_TIMEOUT_MS)

    await rejection
    expect(userInputRequestManager.getOpenRequestsForStore('review')).toHaveLength(0)
    expect(userInputRequestManager.stats.recentResolutions.at(-1)?.outcome).toBe('timeout')
  })

  it('cancels the wait when the proxy request is aborted', async () => {
    const controller = new AbortController()
    const promise = manager.requestReauth(DETAILS, controller.signal)
    const rejection = expect(promise).resolves.toEqual({ outcome: 'withdrawn' })

    controller.abort()

    await rejection
    expect(userInputRequestManager.getOpenRequestsForStore('review')).toHaveLength(0)
  })

  it('clears the card and the parked request when a user dismisses it', async () => {
    const promise = manager.requestReauth(DETAILS)
    const [request] = userInputRequestManager.getAgentScopedRequests('agent-1')

    expect(manager.dismiss(request.id, 'agent-1', 'not my server')).toBe(true)

    expect(await promise).toEqual({ outcome: 'dismissed', reason: 'not my server' })
    expect(userInputRequestManager.getAgentScopedRequests('agent-1')).toHaveLength(0)
    expect(userInputRequestManager.stats.recentResolutions.at(-1)?.outcome).toBe('cancelled')
  })

  it('releases replaced calls for this agent while preserving another agent’s wait', async () => {
    const first = manager.requestReauth(DETAILS)
    const second = manager.requestReauth(DETAILS)
    const other = manager.requestReauth({ ...DETAILS, agentSlug: 'agent-2' })
    const [request] = userInputRequestManager.getAgentScopedRequests('agent-1')
    expect(manager.replaceMcp(request.id, 'agent-2', 'new-mcp')).toBe(false)
    expect(manager.replaceMcp(request.id, 'agent-1', 'new-mcp')).toBe(true)
    expect(await Promise.all([first, second])).toEqual([
      { outcome: 'replaced', replacementId: 'new-mcp' },
      { outcome: 'replaced', replacementId: 'new-mcp' },
    ])
    expect(userInputRequestManager.getAgentScopedRequests('agent-1')).toHaveLength(0)
    expect(userInputRequestManager.getAgentScopedRequests('agent-2')).toHaveLength(1)
    expect(userInputRequestManager.getRecentResolution(request.id)?.outcome).toBe('answered')
    manager.completeMcp('agent-2', 'mcp-1')
    await expect(other).resolves.toEqual({ outcome: 'resumed' })
  })

  it('refuses a dismissal aimed at another agent', async () => {
    const promise = manager.requestReauth(DETAILS)
    const [request] = userInputRequestManager.getAgentScopedRequests('agent-1')

    expect(manager.dismiss(request.id, 'agent-2')).toBe(false)
    expect(userInputRequestManager.getAgentScopedRequests('agent-1')).toHaveLength(1)

    manager.completeMcp('agent-1', 'mcp-1')
    await expect(promise).resolves.toEqual({ outcome: 'resumed' })
  })
})
