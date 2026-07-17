import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createDrawnConnection, deleteGraphConnection, drawnConnectionKind } from './graph-connections'
import type { GraphEdgeSpec } from './use-graph-data'

vi.mock('@renderer/lib/api', () => ({ apiFetch: vi.fn() }))
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

const { apiFetch } = await import('@renderer/lib/api')
const { toast } = await import('sonner')
const apiFetchMock = vi.mocked(apiFetch)

function response(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as Response
}

const permissionEdge = (a: string, b: string, policyCallers: string[]): GraphEdgeSpec => ({
  id: `agent:${a}~agent:${b}`,
  source: `agent:${a}`,
  target: `agent:${b}`,
  variant: 'permission',
  deletable: policyCallers.length > 0,
  policyAgentSlug: policyCallers[0],
  policyCallers,
})

beforeEach(() => {
  vi.clearAllMocks()
})

describe('drawnConnectionKind', () => {
  it('classifies pairs and rejects self-loops and trigger nodes', () => {
    expect(drawnConnectionKind('agent:a', 'agent:b')).toBe('invoke')
    expect(drawnConnectionKind('agent:a', 'agent:a')).toBeNull()
    expect(drawnConnectionKind('agent:a', 'account:x')).toBe('account')
    expect(drawnConnectionKind('mcp:m', 'agent:a')).toBe('mcp')
    expect(drawnConnectionKind('agent:a', 'webhook:w')).toBeNull()
    expect(drawnConnectionKind('account:x', 'mcp:m')).toBeNull()
  })
})

describe('deleteGraphConnection — resource edges', () => {
  it('unlinks an account via the agent-scoped DELETE', async () => {
    apiFetchMock.mockResolvedValueOnce(response(null))
    const changed = await deleteGraphConnection({
      id: 'agent:a->account:acc',
      source: 'agent:a',
      target: 'account:acc',
      variant: 'resource',
    })
    expect(changed).toBe(true)
    expect(apiFetchMock).toHaveBeenCalledWith('/api/agents/a/connected-accounts/acc', { method: 'DELETE' })
    expect(toast.success).toHaveBeenCalled()
  })

  it('reports failure without claiming a change when the unlink is rejected', async () => {
    apiFetchMock.mockResolvedValueOnce(response(null, false, 403))
    const changed = await deleteGraphConnection({
      id: 'agent:a->mcp:m',
      source: 'agent:a',
      target: 'mcp:m',
      variant: 'resource',
    })
    expect(changed).toBe(false)
    expect(apiFetchMock).toHaveBeenCalledWith('/api/agents/a/remote-mcps/m', { method: 'DELETE' })
    expect(toast.error).toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
  })
})

describe('deleteGraphConnection — permission edges', () => {
  it('revokes exactly the editable directions, caller → other end', async () => {
    apiFetchMock.mockResolvedValue(response({ removed: 1 }))
    const changed = await deleteGraphConnection(permissionEdge('a', 'b', ['a', 'b']))
    expect(changed).toBe(true)
    expect(apiFetchMock.mock.calls.map((c) => c[0])).toEqual([
      '/api/agents/a/x-agent-policies/invoke/b',
      '/api/agents/b/x-agent-policies/invoke/a',
    ])
    expect(toast.success).toHaveBeenCalled()
  })

  it('skips directions the user cannot edit', async () => {
    apiFetchMock.mockResolvedValue(response({ removed: 1 }))
    await deleteGraphConnection(permissionEdge('a', 'b', ['b']))
    expect(apiFetchMock.mock.calls.map((c) => c[0])).toEqual(['/api/agents/b/x-agent-policies/invoke/a'])
  })

  it('attempts no requests and reports no change when nothing is editable', async () => {
    const changed = await deleteGraphConnection(permissionEdge('a', 'b', []))
    expect(changed).toBe(false)
    expect(apiFetchMock).not.toHaveBeenCalled()
  })

  it('a failing direction does not abort the rest, and any success still reports changed', async () => {
    // First direction 403s (e.g. role revoked since load), second succeeds.
    apiFetchMock
      .mockResolvedValueOnce(response(null, false, 403))
      .mockResolvedValueOnce(response({ removed: 1 }))
    const changed = await deleteGraphConnection(permissionEdge('a', 'b', ['a', 'b']))
    expect(changed).toBe(true) // caller must invalidate — one direction IS gone
    expect(apiFetchMock).toHaveBeenCalledTimes(2)
    expect(toast.error).toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('reports no change when every direction fails', async () => {
    apiFetchMock.mockResolvedValue(response(null, false, 500))
    const changed = await deleteGraphConnection(permissionEdge('a', 'b', ['a', 'b']))
    expect(changed).toBe(false)
    expect(toast.error).toHaveBeenCalled()
  })

  it('stays quiet when the rows were already gone (removed: 0)', async () => {
    apiFetchMock.mockResolvedValue(response({ removed: 0 }))
    const changed = await deleteGraphConnection(permissionEdge('a', 'b', ['a']))
    expect(changed).toBe(false)
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })
})

describe('createDrawnConnection', () => {
  it('writes the invoke policy on the drag source (drag direction = permission direction)', async () => {
    apiFetchMock.mockResolvedValueOnce(response({ created: true, previousDecision: null }))
    const changed = await createDrawnConnection('agent:caller', 'agent:target')
    expect(changed).toBe(true)
    const [url, init] = apiFetchMock.mock.calls[0]
    expect(url).toBe('/api/agents/caller/x-agent-policies/invoke/target')
    expect(init?.method).toBe('PUT')
    expect(JSON.parse(init?.body as string)).toEqual({ decision: 'allow' })
  })

  it('reports nothing changed when the allow already existed', async () => {
    apiFetchMock.mockResolvedValueOnce(response({ created: false, previousDecision: 'allow' }))
    const changed = await createDrawnConnection('agent:a', 'agent:b')
    expect(changed).toBe(false)
    expect(toast.info).toHaveBeenCalled()
  })

  it('replacing an explicit block still counts as a change and says so', async () => {
    apiFetchMock.mockResolvedValueOnce(response({ created: false, previousDecision: 'block' }))
    const changed = await createDrawnConnection('agent:a', 'agent:b')
    expect(changed).toBe(true)
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('block'))
  })

  it('links an account to the agent regardless of drag direction', async () => {
    apiFetchMock.mockResolvedValue(response({}))
    await createDrawnConnection('account:acc', 'agent:a')
    await createDrawnConnection('agent:a', 'account:acc')
    for (const [url, init] of apiFetchMock.mock.calls) {
      expect(url).toBe('/api/agents/a/connected-accounts')
      expect(JSON.parse(init?.body as string)).toEqual({ accountIds: ['acc'] })
    }
  })

  it('links an MCP server via the remote-mcps route', async () => {
    apiFetchMock.mockResolvedValueOnce(response({}))
    const changed = await createDrawnConnection('agent:a', 'mcp:m')
    expect(changed).toBe(true)
    const [url, init] = apiFetchMock.mock.calls[0]
    expect(url).toBe('/api/agents/a/remote-mcps')
    expect(JSON.parse(init?.body as string)).toEqual({ mcpIds: ['m'] })
  })

  it('refuses undrawable pairs without a request', async () => {
    const changed = await createDrawnConnection('agent:a', 'webhook:w')
    expect(changed).toBe(false)
    expect(apiFetchMock).not.toHaveBeenCalled()
  })

  it('surfaces a failed link as unchanged', async () => {
    apiFetchMock.mockResolvedValueOnce(response(null, false, 500))
    const changed = await createDrawnConnection('agent:a', 'account:acc')
    expect(changed).toBe(false)
    expect(toast.error).toHaveBeenCalled()
  })
})
