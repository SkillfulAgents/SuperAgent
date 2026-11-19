// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest'
import type { ReactNode } from 'react'

// The cache is seeded directly; the mount-time refetch never settles.
vi.mock('@renderer/lib/api', () => ({ apiFetch: () => new Promise(() => {}) }))
const { params } = vi.hoisted(() => ({ params: { slug: undefined as string | undefined } }))
vi.mock('@tanstack/react-router', () => ({ useParams: () => params }))

import { act, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ApiAgent } from '@shared/lib/types/api'
import { useResolvedAgentId, useRouteAgentId } from './use-agents'

const ID = 'abcd123456'
const OTHER = 'zzzz999999'

function agent(slug: string, displaySlug: string, extra: Partial<ApiAgent> = {}): ApiAgent {
  return { avatar: { color: 'tonal-blue', shape: 'circle' } as const, slug, displaySlug, name: displaySlug, createdAt: new Date(0), status: 'stopped', containerPort: null, ...extra }
}

// React Query notifies observers on a timer tick, not synchronously.
async function write(client: QueryClient, agents: ApiAgent[]) {
  await act(async () => {
    client.setQueryData(['agents'], agents)
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
}

function setup(agents: ApiAgent[] | undefined) {
  const client = new QueryClient()
  if (agents) client.setQueryData(['agents'], agents)
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  let renders = 0
  const hook = renderHook(() => {
    renders++
    return useRouteAgentId()
  }, { wrapper })
  return { client, hook, renders: () => renders }
}

describe('useRouteAgentId', () => {
  it('does not re-render its caller when an agents refetch leaves the resolution unchanged', async () => {
    // Every sidebar row calls this hook, and any agent's session event
    // refetches the list: a whole-list subscription re-rendered every row.
    params.slug = `untitled-${ID}`
    const { client, hook, renders } = setup([agent(ID, `sales-${ID}`), agent(OTHER, `support-${OTHER}`)])
    expect(hook.result.current).toBe(ID)
    const settled = renders()

    await write(client, [
      agent(ID, `sales-${ID}`),
      agent(OTHER, `support-${OTHER}`, { hasActiveSessions: true }),
    ])
    expect(renders()).toBe(settled)
  })

  it('follows a change in what the route resolves to', async () => {
    params.slug = `untitled-${ID}`
    const { client, hook } = setup([agent(ID, `sales-${ID}`), agent(OTHER, `support-${OTHER}`)])
    expect(hook.result.current).toBe(ID)

    // Once the agent is gone the raw slug is all that is left.
    await write(client, [agent(OTHER, `support-${OTHER}`)])
    expect(hook.result.current).toBe(`untitled-${ID}`)

    params.slug = `support-${OTHER}`
    hook.rerender()
    expect(hook.result.current).toBe(OTHER)
  })

  it('falls back to the raw slug while the agents list is still loading', () => {
    params.slug = `untitled-${ID}`
    const { hook } = setup(undefined)
    expect(hook.result.current).toBe(`untitled-${ID}`)
  })

  it('does not re-render a caller with no slug either', async () => {
    // A collapsed sidebar row still calls useSessions(null), which resolves
    // through useResolvedAgentId: it must not subscribe to the list's contents.
    const client = new QueryClient()
    client.setQueryData(['agents'], [agent(ID, `sales-${ID}`)])
    let renders = 0
    renderHook(() => {
      renders++
      return useResolvedAgentId(undefined)
    }, { wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> })
    const settled = renders
    await write(client, [agent(ID, `sales-${ID}`, { hasActiveSessions: true })])
    expect(renders).toBe(settled)
  })

  it('is undefined off an agent route', () => {
    params.slug = undefined
    const { hook } = setup([agent(ID, `sales-${ID}`)])
    expect(hook.result.current).toBeUndefined()
  })
})
