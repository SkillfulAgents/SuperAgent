import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import type { ApiAgent } from '@shared/lib/types/api'
import { invalidateAgentArtifacts, markDashboardScreenshotReady, updateAgentRuntimeCache } from './agent-cache'

const agent: ApiAgent = {
  slug: 'agent-a',
  displaySlug: 'agent-a-display',
  name: 'Agent A',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  status: 'stopped',
  containerPort: null,
  sessionCount: 7,
  dashboards: [
    { slug: 'sales', name: 'Sales' },
    { slug: 'support', name: 'Support' },
  ],
}

function seededClient() {
  const client = new QueryClient()
  client.setQueryData(['agents'], [agent, { ...agent, slug: 'agent-b', displaySlug: 'agent-b' }])
  client.setQueryData(['agents', 'agent-a'], agent)
  client.setQueryData(['agents', 'agent-a-display'], agent)
  return client
}

describe('targeted agent cache updates', () => {
  it('updates runtime state in list and every cached detail alias without losing summaries', () => {
    const client = seededClient()

    updateAgentRuntimeCache(client, 'agent-a', 'running', 3456)

    expect(client.getQueryData<ApiAgent[]>(['agents'])?.[0]).toMatchObject({
      status: 'running',
      containerPort: 3456,
      sessionCount: 7,
    })
    expect(client.getQueryData<ApiAgent>(['agents', 'agent-a'])).toMatchObject({
      status: 'running',
      containerPort: 3456,
    })
    expect(client.getQueryData<ApiAgent>(['agents', 'agent-a-display'])).toMatchObject({
      status: 'running',
      containerPort: 3456,
    })
    expect(client.getQueryData<ApiAgent[]>(['agents'])?.[1].status).toBe('stopped')
  })

  it('clears a stale port on stop events that carry no port', () => {
    const client = seededClient()
    updateAgentRuntimeCache(client, 'agent-a', 'running', 3456)

    updateAgentRuntimeCache(client, 'agent-a', 'stopped')

    expect(client.getQueryData<ApiAgent>(['agents', 'agent-a'])).toMatchObject({
      status: 'stopped',
      containerPort: null,
    })
  })

  it('marks only the announced dashboard screenshot ready', () => {
    const client = seededClient()

    markDashboardScreenshotReady(client, 'agent-a', 'sales')

    expect(client.getQueryData<ApiAgent>(['agents', 'agent-a'])?.dashboards).toEqual([
      { slug: 'sales', name: 'Sales', hasScreenshot: true },
      { slug: 'support', name: 'Support' },
    ])
    expect(client.getQueryData<ApiAgent[]>(['agents'])?.[1].dashboards?.[0]).not.toHaveProperty('hasScreenshot')
  })

  it('invalidates only the matching agent artifact queries, including its display alias', () => {
    const client = seededClient()
    client.setQueryData(['artifacts', 'agent-a'], [])
    client.setQueryData(['artifacts', 'agent-a-display'], [])
    client.setQueryData(['artifacts', 'agent-b'], [])

    invalidateAgentArtifacts(client, 'agent-a')

    expect(client.getQueryState(['artifacts', 'agent-a'])?.isInvalidated).toBe(true)
    expect(client.getQueryState(['artifacts', 'agent-a-display'])?.isInvalidated).toBe(true)
    expect(client.getQueryState(['artifacts', 'agent-b'])?.isInvalidated).toBe(false)
  })
})
