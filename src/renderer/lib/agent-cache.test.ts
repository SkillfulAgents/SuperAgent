import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import type { ApiAgent, ApiSession } from '@shared/lib/types/api'
import {
  applySessionActivityStatus,
  invalidateAgentArtifacts,
  markDashboardScreenshotReady,
  updateAgentRuntimeCache,
} from './agent-cache'

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

  describe('applySessionActivityStatus', () => {
    const session = (id: string, overrides?: Partial<ApiSession>): ApiSession => ({
      id,
      agentSlug: 'agent-a',
      name: `Session ${id}`,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      lastActivityAt: new Date('2026-01-01T00:00:00.000Z'),
      messageCount: 1,
      isActive: true,
      ...overrides,
    })

    function seededSessionClient(sessions: ApiSession[]) {
      const client = seededClient()
      client.setQueryData(['sessions', 'agent-a'], sessions)
      client.setQueryData(['sessions', 'agent-a', 'notable', 25], sessions)
      client.setQueryData(['session', 'sess-1', 'agent-a'], sessions[0])
      return client
    }

    it('raises the flag on the session entry and the agent rollup in every cache', () => {
      const client = seededSessionClient([session('sess-1'), session('sess-2')])

      applySessionActivityStatus(client, 'agent-a', 'sess-1', { isActive: true, isAwaitingInput: true })

      expect(client.getQueryData<ApiSession[]>(['sessions', 'agent-a'])?.[0].isAwaitingInput).toBe(true)
      expect(client.getQueryData<ApiSession[]>(['sessions', 'agent-a'])?.[1].isAwaitingInput).toBeUndefined()
      expect(client.getQueryData<ApiSession[]>(['sessions', 'agent-a', 'notable', 25])?.[0].isAwaitingInput).toBe(true)
      expect(client.getQueryData<ApiSession>(['session', 'sess-1', 'agent-a'])?.isAwaitingInput).toBe(true)
      expect(client.getQueryData<ApiAgent[]>(['agents'])?.[0].hasSessionsAwaitingInput).toBe(true)
      expect(client.getQueryData<ApiAgent[]>(['agents'])?.[1].hasSessionsAwaitingInput).toBeUndefined()
      expect(client.getQueryData<ApiAgent>(['agents', 'agent-a'])?.hasSessionsAwaitingInput).toBe(true)
      expect(client.getQueryData<ApiAgent>(['agents', 'agent-a-display'])?.hasSessionsAwaitingInput).toBe(true)
    })

    it('clears the session entry and drops the rollup when no sibling session is awaiting', () => {
      const client = seededSessionClient([
        session('sess-1', { isAwaitingInput: true }),
        session('sess-2'),
      ])
      applySessionActivityStatus(client, 'agent-a', 'sess-1', { isAwaitingInput: true })

      applySessionActivityStatus(client, 'agent-a', 'sess-1', { isAwaitingInput: false })

      expect(client.getQueryData<ApiSession[]>(['sessions', 'agent-a'])?.[0].isAwaitingInput).toBe(false)
      expect(client.getQueryData<ApiSession>(['session', 'sess-1', 'agent-a'])?.isAwaitingInput).toBe(false)
      expect(client.getQueryData<ApiAgent[]>(['agents'])?.[0].hasSessionsAwaitingInput).toBe(false)
      expect(client.getQueryData<ApiAgent>(['agents', 'agent-a'])?.hasSessionsAwaitingInput).toBe(false)
    })

    it('keeps the rollup raised while a sibling session is still awaiting', () => {
      const client = seededSessionClient([
        session('sess-1', { isAwaitingInput: true }),
        session('sess-2', { isAwaitingInput: true }),
      ])
      applySessionActivityStatus(client, 'agent-a', 'sess-1', { isAwaitingInput: true })

      applySessionActivityStatus(client, 'agent-a', 'sess-1', { isAwaitingInput: false })

      expect(client.getQueryData<ApiSession[]>(['sessions', 'agent-a'])?.[0].isAwaitingInput).toBe(false)
      expect(client.getQueryData<ApiAgent[]>(['agents'])?.[0].hasSessionsAwaitingInput).toBe(true)
      expect(client.getQueryData<ApiAgent>(['agents', 'agent-a'])?.hasSessionsAwaitingInput).toBe(true)
    })

    it('skips the echo entirely when only a truncated slice is cached — refetch keeps authority', () => {
      const client = seededClient()
      client.setQueryData(['agents'], [
        { ...agent, hasSessionsAwaitingInput: true },
        { ...agent, slug: 'agent-b', displaySlug: 'agent-b' },
      ])
      // Only the notable slice is cached — no authoritative full list and no
      // detail entry. The O(1) relevance gate skips the walks: the truncated
      // slice could not validate a rollup clear anyway, and probing for it
      // would put a full-cache walk back on the per-event path.
      client.setQueryData(
        ['sessions', 'agent-a', 'notable', 25],
        [session('sess-1', { isAwaitingInput: true })],
      )

      expect(applySessionActivityStatus(client, 'agent-a', 'sess-1', { isAwaitingInput: false })).toBe(false)

      expect(
        client.getQueryData<ApiSession[]>(['sessions', 'agent-a', 'notable', 25])?.[0].isAwaitingInput,
      ).toBe(true)
      expect(client.getQueryData<ApiAgent[]>(['agents'])?.[0].hasSessionsAwaitingInput).toBe(true)
    })

    it('leaves the rollup to the refetch when no session list is cached', () => {
      const client = seededClient()
      client.setQueryData(['agents'], [
        { ...agent, hasSessionsAwaitingInput: true },
        { ...agent, slug: 'agent-b', displaySlug: 'agent-b' },
      ])

      applySessionActivityStatus(client, 'agent-a', 'sess-1', { isAwaitingInput: false })

      expect(client.getQueryData<ApiAgent[]>(['agents'])?.[0].hasSessionsAwaitingInput).toBe(true)
    })

    it('never touches another agent\'s sessions or rollup', () => {
      const client = seededSessionClient([session('sess-1', { isAwaitingInput: true })])
      const otherSessions = [session('sess-1', { agentSlug: 'agent-b', isAwaitingInput: true })]
      client.setQueryData(['sessions', 'agent-b'], otherSessions)

      applySessionActivityStatus(client, 'agent-a', 'sess-1', { isAwaitingInput: false })

      expect(client.getQueryData<ApiSession[]>(['sessions', 'agent-b'])?.[0].isAwaitingInput).toBe(true)
      expect(client.getQueryData<ApiSession[]>(['sessions', 'agent-a'])?.[0].isAwaitingInput).toBe(false)
    })

    it('an idle patch clears both flags and both rollups when the last live session settles', () => {
      const client = seededSessionClient([
        session('sess-1', { isAwaitingInput: true }),
        session('sess-2', { isActive: false }),
      ])
      client.setQueryData(['agents'], [
        { ...agent, hasActiveSessions: true, hasSessionsAwaitingInput: true },
        { ...agent, slug: 'agent-b', displaySlug: 'agent-b' },
      ])

      applySessionActivityStatus(client, 'agent-a', 'sess-1', { isActive: false, isAwaitingInput: false })

      expect(client.getQueryData<ApiSession[]>(['sessions', 'agent-a'])?.[0]).toMatchObject({
        isActive: false,
        isAwaitingInput: false,
      })
      expect(client.getQueryData<ApiAgent[]>(['agents'])?.[0]).toMatchObject({
        hasActiveSessions: false,
        hasSessionsAwaitingInput: false,
      })
    })

    it('an idle patch keeps hasActiveSessions raised while a sibling is still working', () => {
      const client = seededSessionClient([
        session('sess-1'),
        session('sess-2', { isAwaitingInput: true }),
      ])
      client.setQueryData(['agents'], [
        { ...agent, hasActiveSessions: true, hasSessionsAwaitingInput: true },
      ])

      applySessionActivityStatus(client, 'agent-a', 'sess-1', { isActive: false, isAwaitingInput: false })

      // sess-2 is active AND awaiting — both rollups must survive sess-1 settling.
      expect(client.getQueryData<ApiSession[]>(['sessions', 'agent-a'])?.[0].isActive).toBe(false)
      expect(client.getQueryData<ApiAgent[]>(['agents'])?.[0]).toMatchObject({
        hasActiveSessions: true,
        hasSessionsAwaitingInput: true,
      })
    })

    it('raises the unread dot on the session entry and the agent rollup', () => {
      const client = seededSessionClient([session('sess-1', { isActive: false }), session('sess-2')])

      applySessionActivityStatus(client, 'agent-a', 'sess-1', { hasUnreadNotifications: true })

      expect(client.getQueryData<ApiSession[]>(['sessions', 'agent-a'])?.[0].hasUnreadNotifications).toBe(true)
      expect(client.getQueryData<ApiSession[]>(['sessions', 'agent-a'])?.[1].hasUnreadNotifications).toBeUndefined()
      expect(client.getQueryData<ApiAgent[]>(['agents'])?.[0].hasUnreadNotifications).toBe(true)
      expect(client.getQueryData<ApiAgent>(['agents', 'agent-a'])?.hasUnreadNotifications).toBe(true)
      expect(client.getQueryData<ApiAgent[]>(['agents'])?.[1].hasUnreadNotifications).toBeUndefined()
    })

    it('an active patch raises the session and rollup without touching the awaiting flag', () => {
      const client = seededSessionClient([session('sess-1', { isActive: false })])

      applySessionActivityStatus(client, 'agent-a', 'sess-1', { isActive: true })

      expect(client.getQueryData<ApiSession[]>(['sessions', 'agent-a'])?.[0].isActive).toBe(true)
      expect(client.getQueryData<ApiSession[]>(['sessions', 'agent-a'])?.[0].isAwaitingInput).toBeUndefined()
      expect(client.getQueryData<ApiAgent[]>(['agents'])?.[0].hasActiveSessions).toBe(true)
      expect(client.getQueryData<ApiAgent[]>(['agents'])?.[0].hasSessionsAwaitingInput).toBeUndefined()
    })

    it('an active raise also asserts the container is running in every agent cache', () => {
      const client = seededSessionClient([session('sess-1', { isActive: false })])

      applySessionActivityStatus(client, 'agent-a', 'sess-1', { isActive: true })

      expect(client.getQueryData<ApiAgent[]>(['agents'])?.[0].status).toBe('running')
      expect(client.getQueryData<ApiAgent>(['agents', 'agent-a'])?.status).toBe('running')
      expect(client.getQueryData<ApiAgent>(['agents', 'agent-a-display'])?.status).toBe('running')
      expect(client.getQueryData<ApiAgent[]>(['agents'])?.[1].status).toBe('stopped')
    })

    it('an awaiting raise asserts running; clears never lower the container status', () => {
      const client = seededSessionClient([session('sess-1', { isActive: false })])

      applySessionActivityStatus(client, 'agent-a', 'sess-1', { isAwaitingInput: true })
      expect(client.getQueryData<ApiAgent>(['agents', 'agent-a'])?.status).toBe('running')

      applySessionActivityStatus(client, 'agent-a', 'sess-1', { isActive: false, isAwaitingInput: false })
      expect(client.getQueryData<ApiAgent>(['agents', 'agent-a'])?.status).toBe('running')
    })

    it('a raise on an already-running agent keeps the agent reference', () => {
      const client = seededSessionClient([session('sess-1')])
      updateAgentRuntimeCache(client, 'agent-a', 'running', 3456)
      applySessionActivityStatus(client, 'agent-a', 'sess-1', { isActive: true })
      const before = client.getQueryData<ApiAgent>(['agents', 'agent-a'])

      applySessionActivityStatus(client, 'agent-a', 'sess-1', { isActive: true })

      expect(client.getQueryData<ApiAgent>(['agents', 'agent-a'])).toBe(before)
    })
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
