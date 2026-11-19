import { describe, expect, it, vi } from 'vitest'
import { fetchAgentsWithStatus, POLL_HEADERS } from './agent-status'

const BASE = 'http://localhost:4000/cloud/SECRET-PROXY-KEY'

function api(agents: unknown, settings: unknown = {}, agentsStatus = 200) {
  const requests: Array<{ url: string; headers: unknown }> = []
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    requests.push({ url, headers: init?.headers })
    if (url === `${BASE}/api/agents`) return Response.json(agents, { status: agentsStatus })
    if (url === `${BASE}/api/user-settings`) return Response.json(settings)
    return new Response('{}', { status: 404 })
  })
  return { fetch: fetch as unknown as typeof globalThis.fetch, requests }
}

describe('fetchAgentsWithStatus', () => {
  it('reads each agent\'s activity from the list: two requests, however many agents are running', async () => {
    const { fetch, requests } = api([
      { slug: 'a', name: 'A', status: 'running', hasActiveSessions: true, hasSessionsAwaitingInput: false },
      { slug: 'b', name: 'B', status: 'running', hasActiveSessions: true, hasSessionsAwaitingInput: true },
      { slug: 'c', name: 'C', status: 'running', hasActiveSessions: false, hasSessionsAwaitingInput: false },
      { slug: 'd', name: 'D', status: 'stopped', hasActiveSessions: false, hasSessionsAwaitingInput: false },
      // A deployment that does not send the flags lists the agent as idle.
      { slug: 'e', name: 'E', status: 'running' },
    ])

    expect(await fetchAgentsWithStatus(BASE, fetch)).toEqual([
      { slug: 'a', name: 'A', activityStatus: 'working' },
      { slug: 'b', name: 'B', activityStatus: 'awaiting_input' },
      { slug: 'c', name: 'C', activityStatus: 'idle' },
      { slug: 'd', name: 'D', activityStatus: 'sleeping' },
      { slug: 'e', name: 'E', activityStatus: 'idle' },
    ])
    expect(requests.map((request) => request.url).sort()).toEqual([`${BASE}/api/agents`, `${BASE}/api/user-settings`])
    // Marked as polls, so they never consume the reloading renderer's boot prefetch.
    for (const request of requests) expect(request.headers).toEqual(POLL_HEADERS)
  })

  it('orders agents as the window does: unsaved ones first, newest first, then the saved order', async () => {
    const { fetch } = api(
      [
        { slug: 'saved-2', name: 'saved-2', status: 'stopped', createdAt: '2025-01-01T00:00:00.000Z' },
        { slug: 'older', name: 'older', status: 'stopped', createdAt: '2025-02-01T00:00:00.000Z' },
        { slug: 'saved-1', name: 'saved-1', status: 'stopped', createdAt: '2025-03-01T00:00:00.000Z' },
        { slug: 'newer', name: 'newer', status: 'stopped', createdAt: '2025-04-01T00:00:00.000Z' },
      ],
      { agentOrder: ['saved-1', 'gone', 'saved-2'] },
    )
    const listed = await fetchAgentsWithStatus(BASE, fetch)
    expect(listed.map((agent) => agent.slug)).toEqual(['newer', 'older', 'saved-1', 'saved-2'])
  })

  it('drops a malformed row rather than the list', async () => {
    const { fetch } = api([{ name: 'no slug' }, 'nonsense', { slug: 'ok', name: 'OK', status: 'starting' }])
    expect(await fetchAgentsWithStatus(BASE, fetch)).toEqual([{ slug: 'ok', name: 'OK', activityStatus: 'idle' }])
  })

  it('lists no agents when the API refuses or answers something else', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await fetchAgentsWithStatus(BASE, api([], {}, 401).fetch)).toEqual([])
    expect(await fetchAgentsWithStatus(BASE, api({ error: 'nope' }).fetch)).toEqual([])
    error.mockRestore()
  })
})
