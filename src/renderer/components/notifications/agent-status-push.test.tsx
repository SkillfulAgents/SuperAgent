// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { agentStatusPushSchema } from '@shared/lib/types/agent-status-push'
import { AgentStatusPush } from './agent-status-push'

const api = vi.hoisted(() => ({
  agents: [] as unknown[],
  agentsOk: true,
  settings: {} as Record<string, unknown>,
}))
vi.mock('@renderer/lib/api', () => ({
  apiFetch: async (path: string) => {
    if (path === '/api/agents') return { ok: api.agentsOk, json: async () => api.agents } as Response
    return { ok: true, json: async () => api.settings } as Response
  },
}))

const agent = (slug: string, extra: Record<string, unknown> = {}) => ({
  slug,
  name: slug.toUpperCase(),
  status: 'running',
  createdAt: '2025-01-01T00:00:00.000Z',
  hasActiveSessions: false,
  hasSessionsAwaitingInput: false,
  ...extra,
})

describe('AgentStatusPush', () => {
  let client: QueryClient
  let pushAgentStatus: ReturnType<typeof vi.fn>

  function mount() {
    return render(
      <QueryClientProvider client={client}>
        <AgentStatusPush />
      </QueryClientProvider>,
    )
  }

  beforeEach(() => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    api.agents = [agent('a'), agent('b', { hasActiveSessions: true }), agent('c', { status: 'stopped' })]
    api.agentsOk = true
    api.settings = { agentOrder: ['c', 'a', 'b'] }
    pushAgentStatus = vi.fn(async () => true)
    ;(window as unknown as { electronAPI?: unknown }).electronAPI = { pushAgentStatus }
  })

  afterEach(() => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI
  })

  it('pushes the ordered list once the agents and the saved order have answered', async () => {
    mount()
    await waitFor(() => expect(pushAgentStatus).toHaveBeenCalled())

    expect(pushAgentStatus.mock.calls).toEqual([[{
      target: 'local',
      agents: [
        { slug: 'c', name: 'C', activityStatus: 'sleeping' },
        { slug: 'a', name: 'A', activityStatus: 'idle' },
        { slug: 'b', name: 'B', activityStatus: 'working' },
      ],
    }]])
    // What it sends is what main accepts.
    expect(agentStatusPushSchema.safeParse(pushAgentStatus.mock.calls[0][0]).success).toBe(true)
  })

  it('pushes again only when something the menus show has changed', async () => {
    mount()
    await waitFor(() => expect(pushAgentStatus).toHaveBeenCalledTimes(1))

    // The stream rewrites rows constantly: unread flags, previews, activity times.
    act(() => {
      client.setQueryData(['agents'], api.agents.map((row) => ({ ...(row as object), hasUnreadNotifications: true, lastActivityAt: 'now' })))
    })
    expect(pushAgentStatus).toHaveBeenCalledTimes(1)

    act(() => {
      client.setQueryData(['agents'], [agent('a', { hasSessionsAwaitingInput: true }), agent('b'), agent('c', { status: 'stopped' })])
    })
    await waitFor(() => expect(pushAgentStatus).toHaveBeenCalledTimes(2))
    expect(pushAgentStatus.mock.calls[1][0].agents).toEqual([
      { slug: 'c', name: 'C', activityStatus: 'sleeping' },
      { slug: 'a', name: 'A', activityStatus: 'awaiting_input' },
      { slug: 'b', name: 'B', activityStatus: 'idle' },
    ])
  })

  it('withdraws its list when the agents query fails, and when it unmounts', async () => {
    const view = mount()
    await waitFor(() => expect(pushAgentStatus).toHaveBeenCalledTimes(1))

    api.agentsOk = false
    await act(async () => {
      await client.refetchQueries({ queryKey: ['agents'] })
    })
    await waitFor(() => expect(pushAgentStatus).toHaveBeenCalledTimes(2))
    expect(pushAgentStatus).toHaveBeenLastCalledWith(null)

    api.agentsOk = true
    await act(async () => {
      await client.refetchQueries({ queryKey: ['agents'] })
    })
    await waitFor(() => expect(pushAgentStatus).toHaveBeenCalledTimes(3))

    view.unmount()
    expect(pushAgentStatus).toHaveBeenCalledTimes(4)
    expect(pushAgentStatus).toHaveBeenLastCalledWith(null)
  })

  it('pushes nothing when the agents never load', async () => {
    api.agentsOk = false
    const view = mount()
    await waitFor(() => expect(client.getQueryState(['agents'])?.status).toBe('error'))
    view.unmount()
    expect(pushAgentStatus).not.toHaveBeenCalled()
  })

  it('does nothing outside the desktop app', async () => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI
    mount()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(client.getQueryState(['agents'])).toBeUndefined()
  })
})
