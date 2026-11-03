// @vitest-environment jsdom
import { QueryClient, QueryObserver } from '@tanstack/react-query'
import { describe, it, expect, vi } from 'vitest'
import { waitFor } from '@testing-library/react'
import type { ApiAgent, ApiNotification, ApiSession } from '@shared/lib/types/api'
import type { NotificationReadState } from '@shared/lib/notifications/read-state-schema'
import { readNotifications, noteNotificationChange } from './notification-read-cache'
import { apiFetch } from './api'

vi.mock('./api', () => ({ apiFetch: vi.fn() }))

function notification(id = 'n1', sessionId = 's1'): ApiNotification {
  return { id, sessionId, agentSlug: 'a', type: 'session_complete', title: 'Done', body: id, isRead: false, createdAt: new Date(0), readAt: null }
}
function seed() {
  vi.mocked(apiFetch).mockReset()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const agent = {
    slug: 'a', displaySlug: 'agent-a', hasUnreadNotifications: true, hasUnreadMention: true,
    hasSessionsAwaitingInput: true, notificationPreview: 'n1', notificationPreviewSource: { id: 'n1', sessionId: 's1' },
    markedUnreadSessionIds: ['manual'],
  }
  client.setQueryData(['agents'], [agent])
  client.setQueryData(['agents', 'agent-a'], agent)
  const sessions = ['s1', 'manual'].map(id => ({ id, agentSlug: 'a', hasUnreadNotifications: true, hasUnreadMention: id === 's1', isAwaitingInput: id === 's1' }))
  client.setQueryData(['sessions', 'a'], sessions)
  client.setQueryData(['sessions', 'agent-a', 'notable', 25], sessions)
  client.setQueryData(['session', 's1', 'a'], sessions[0])
  client.setQueryData(['notifications', 15, 0], { items: [notification()], total: 1 })
  client.setQueryData(['notifications', 'unread-count'], { count: 1, mentions: 0 })
  const invalidate = vi.spyOn(client, 'invalidateQueries')
  return { client, invalidate }
}
const agent = (client: QueryClient) => client.getQueryData<ApiAgent[]>(['agents'])![0]
const page = (client: QueryClient) => client.getQueryData<{ items: ApiNotification[] }>(['notifications', 15, 0])!
function deferred() {
  let resolve!: (value: Response) => void
  let reject!: (error: Error) => void
  const promise = new Promise<Response>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function response(readState?: NotificationReadState) {
  return new Response(JSON.stringify({ success: true, readState }), { headers: { 'Content-Type': 'application/json' } })
}
function state(preview?: string): NotificationReadState {
  return { count: preview ? 1 : 0, mentions: 0, agents: [{
    slug: 'a', hasUnreadNotifications: true, hasUnreadMention: false,
    markedUnreadSessionIds: ['manual'], unreadSessionIds: preview ? ['s2', 'manual'] : ['manual'], mentionedSessionIds: [],
    ...(preview ? { notificationPreview: preview, notificationPreviewSource: { id: preview, sessionId: 's2' } } : {}),
  }] }
}

describe('optimistic notification reads', () => {
  it('clears previews, pages and counts before the POST completes, preserving input and manual reminders', async () => {
    const { client, invalidate } = seed()
    const pending = deferred()
    vi.mocked(apiFetch).mockReturnValueOnce(pending.promise)
    const operation = readNotifications(client, { kind: 'all' })
    await waitFor(() => expect(agent(client).notificationPreview).toBeUndefined())
    expect(agent(client)).toMatchObject({ hasUnreadNotifications: true, hasUnreadMention: false, hasSessionsAwaitingInput: true })
    expect(client.getQueryData(['agents', 'agent-a'])).toEqual(agent(client))
    expect(client.getQueryData(['notifications', 'unread-count'])).toEqual({ count: 0, mentions: 0 })
    expect(page(client).items[0].isRead).toBe(true)
    expect(client.getQueryData<ApiSession[]>(['sessions', 'a'])!.map(s => s.hasUnreadNotifications)).toEqual([false, true])
    expect(client.getQueryData<ApiSession>(['session', 's1', 'a'])).toMatchObject({ hasUnreadNotifications: false, isAwaitingInput: true })
    pending.resolve(response(state()))
    await operation
    expect(apiFetch).toHaveBeenCalledExactlyOnceWith('/api/notifications/read-all', { method: 'POST' })
    expect(invalidate).not.toHaveBeenCalled()
  })

  it('replaces a single read preview with an uncached remaining notification from the write response', async () => {
    const { client, invalidate } = seed()
    const pending = deferred()
    vi.mocked(apiFetch).mockReturnValueOnce(pending.promise)
    const operation = readNotifications(client, { kind: 'notification', id: 'n1' })
    await waitFor(() => expect(agent(client).notificationPreview).toBeUndefined())
    pending.resolve(response(state('n2')))
    await operation
    expect(agent(client)).toMatchObject({ notificationPreview: 'n2', notificationPreviewSource: { id: 'n2', sessionId: 's2' }, hasUnreadNotifications: true })
    expect(client.getQueryData<ApiSession>(['session', 's1', 'a'])!.hasUnreadNotifications).toBe(false)
    expect(invalidate).not.toHaveBeenCalled()
    expect(apiFetch).toHaveBeenCalledTimes(1)
  })

  it('refreshes unread state from older servers without guessing which sessions are personal reminders', async () => {
    const { client } = seed()
    // Older agents responses do not distinguish notifications from reminders.
    const legacyAgent = { ...agent(client), markedUnreadSessionIds: undefined }
    client.setQueryData(['agents'], [legacyAgent])
    client.setQueryData(['agents', 'agent-a'], legacyAgent)
    const sessions = client.getQueryData<ApiSession[]>(['sessions', 'a'])!
    const fetchSessions = vi.fn().mockResolvedValue(sessions.map(session => ({
      ...session, hasUnreadNotifications: session.id === 'manual', hasUnreadMention: false,
    })))
    const observer = new QueryObserver(client, {
      queryKey: ['sessions', 'a'], queryFn: fetchSessions, staleTime: Infinity,
    })
    const unsubscribe = observer.subscribe(() => {})
    try {
      const pending = deferred()
      vi.mocked(apiFetch).mockReturnValueOnce(pending.promise)
      const operation = readNotifications(client, { kind: 'all' })
      await waitFor(() => expect(page(client).items[0].isRead).toBe(true))
      expect(fetchSessions).not.toHaveBeenCalled()
      expect(client.getQueryData<ApiSession[]>(['sessions', 'a'])!.map(s => s.hasUnreadNotifications)).toEqual([true, true])

      pending.resolve(response())
      await operation
      expect(fetchSessions).toHaveBeenCalledTimes(1)
      expect(client.getQueryData<ApiSession[]>(['sessions', 'a'])!.map(s => s.hasUnreadNotifications)).toEqual([false, true])
      // Inactive queries refresh when next observed, without extra requests now.
      expect(client.getQueryState(['agents'])?.isInvalidated).toBe(true)
    } finally {
      unsubscribe()
      client.clear()
    }
  })

  it('does not clear a different preview when reading a session or notification', async () => {
    for (const target of [{ kind: 'session', sessionId: 's2' }, { kind: 'notification', id: 'n2' }] as const) {
      const { client } = seed()
      vi.mocked(apiFetch).mockResolvedValueOnce(response())
      await readNotifications(client, target)
      expect(agent(client).notificationPreview).toBe('n1')
    }
  })

  it('rolls back a failed write while preserving a newer notification and unrelated agent edits', async () => {
    const { client } = seed()
    const pending = deferred()
    vi.mocked(apiFetch).mockReturnValueOnce(pending.promise)
    const operation = readNotifications(client, { kind: 'all' })
    const rejected = expect(operation).rejects.toThrow('offline')
    await waitFor(() => expect(page(client).items[0].isRead).toBe(true))
    client.setQueryData(['notifications', 15, 0], { items: [notification('new'), ...page(client).items], total: 2 })
    client.setQueryData(['agents'], [{ ...agent(client), name: 'Renamed', notificationPreview: 'new', notificationPreviewSource: { id: 'new', sessionId: 's2' }, hasUnreadNotifications: true }])
    client.setQueryData(['notifications', 'unread-count'], { count: 2, mentions: 0 })
    pending.reject(new Error('offline'))
    await rejected
    expect(page(client).items.map(n => [n.id, n.isRead])).toEqual([['new', false], ['n1', false]])
    expect(agent(client)).toMatchObject({ name: 'Renamed', notificationPreview: 'new' })
    expect(client.getQueryData(['notifications', 'unread-count'])).toEqual({ count: 2, mentions: 0 })
  })

  it('does not overwrite a newer preview/count with an older success response', async () => {
    const { client } = seed()
    const pending = deferred()
    vi.mocked(apiFetch).mockReturnValueOnce(pending.promise)
    const operation = readNotifications(client, { kind: 'all' })
    await waitFor(() => expect(agent(client).notificationPreview).toBeUndefined())
    client.setQueryData(['agents'], [{ ...agent(client), notificationPreview: 'new', notificationPreviewSource: { id: 'new', sessionId: 's3' }, hasUnreadNotifications: true }])
    client.setQueryData(['notifications', 'unread-count'], { count: 1, mentions: 0 })
    pending.resolve(response(state()))
    await operation
    expect(agent(client).notificationPreview).toBe('new')
    expect(client.getQueryData(['notifications', 'unread-count'])).toEqual({ count: 1, mentions: 0 })
  })

  it('serializes overlapping reads so a failure cannot undo the next successful write', async () => {
    const { client } = seed()
    const first = deferred()
    vi.mocked(apiFetch).mockReturnValueOnce(first.promise).mockResolvedValueOnce(response(state()))
    const one = readNotifications(client, { kind: 'all' })
    const rejected = expect(one).rejects.toThrow('offline')
    const two = readNotifications(client, { kind: 'session', sessionId: 's1' })
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1))
    first.reject(new Error('offline'))
    await rejected
    await two
    expect(page(client).items[0].isRead).toBe(true)
    expect(agent(client).notificationPreview).toBeUndefined()
    expect(apiFetch).toHaveBeenCalledTimes(2)
  })

  it('lets a new SSE event win even before its refetch updates the cache', async () => {
    const { client } = seed()
    const pending = deferred()
    vi.mocked(apiFetch).mockReturnValueOnce(pending.promise)
    const operation = readNotifications(client, { kind: 'notification', id: 'n1' })
    await waitFor(() => expect(agent(client).notificationPreview).toBeUndefined())
    noteNotificationChange(client, 'a')
    pending.resolve(response(state('outdated')))
    await operation
    expect(agent(client).notificationPreview).toBeUndefined()
    expect(client.getQueryData(['notifications', 'unread-count'])).toEqual({ count: 0, mentions: 0 })
  })

  it('cancels a stale GET without cancelling an uncached initial load', async () => {
    const { client } = seed()
    const stale = deferred()
    const initial = deferred()
    const cached = { ...agent(client) }
    const refetch = client.fetchQuery({ queryKey: ['agents'], queryFn: async () => { await stale.promise; return [cached] } })
      .catch(() => undefined)
    const firstLoad = client.fetchQuery({ queryKey: ['sessions', 'other'], queryFn: async () => { await initial.promise; return [{ id: 'other-session' }] } })
    vi.mocked(apiFetch).mockResolvedValueOnce(response(state()))
    await readNotifications(client, { kind: 'all' })
    stale.resolve(response())
    initial.resolve(response())
    await Promise.all([refetch, firstLoad])
    expect(agent(client).notificationPreview).toBeUndefined()
    expect(client.getQueryData(['sessions', 'other'])).toEqual([{ id: 'other-session' }])
    // No observer needs this metadata now, but cancellation must not mark the
    // old value fresh: the next observer should fetch it again.
    expect(client.getQueryState(['agents'])?.isInvalidated).toBe(true)
  })

  it.each(['confirmed', 'legacy', 'failed'] as const)('recovers interrupted list and both slug aliases after a %s read', async (mode) => {
    const { client } = seed()
    const old = { ...agent(client), name: 'Untitled' }
    const renamed = { ...old, name: 'Renamed', displaySlug: 'renamed-a' }
    const keys = [['agents'], ['agents', 'a'], ['agents', 'agent-a']]
    const stale = deferred()
    const recovery = deferred()
    const post = deferred()
    let fetches = 0
    const unsubscribes = keys.map(key => {
      client.setQueryData(key, key.length === 1 ? [old] : old)
      const observer = new QueryObserver(client, {
        queryKey: key, staleTime: Infinity,
        queryFn: async () => {
          const interrupted = ++fetches <= keys.length
          await (interrupted ? stale.promise : recovery.promise)
          const value = { ...renamed, notificationPreview: interrupted || mode === 'failed' ? 'n1' : undefined }
          return key.length === 1 ? [value] : value
        },
      })
      return observer.subscribe(() => {})
    })
    const names = () => keys.map(key => {
      const value = client.getQueryData<ApiAgent | ApiAgent[]>(key)!
      return (Array.isArray(value) ? value[0] : value).name
    })
    try {
      const refetch = client.invalidateQueries({ queryKey: ['agents'] })
      expect(fetches).toBe(3)
      vi.mocked(apiFetch).mockReturnValueOnce(post.promise).mockResolvedValueOnce(response(state()))
      let settled = false
      const operation = readNotifications(client, { kind: 'session', sessionId: 's1' })
        .then(value => ({ value }), error => ({ error }))
        .finally(() => { settled = true })
      await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1))
      const queued = readNotifications(client, { kind: 'notification', id: 'n1' })
      if (mode === 'failed') post.reject(new Error('offline'))
      else post.resolve(response(mode === 'confirmed' ? state() : undefined))
      await waitFor(() => expect(fetches).toBe(6))
      expect(settled).toBe(false)
      expect(apiFetch).toHaveBeenCalledTimes(1)

      // The canceled GET can finish late with a renamed agent and an old
      // unread projection. Only the new post-write refetch may publish it.
      stale.resolve(response())
      await refetch
      expect(names()).toEqual(['Untitled', 'Untitled', 'Untitled'])
      recovery.resolve(response())
      const result = await operation
      if (mode === 'failed') expect(result).toMatchObject({ error: new Error('offline') })
      else expect(result).toHaveProperty('value.success', true)
      await queued
      expect(names()).toEqual(['Renamed', 'Renamed', 'Renamed'])
      expect(agent(client).notificationPreview).toBeUndefined()
      expect(fetches).toBe(6) // The legacy broad refresh does not recover twice.
      expect(apiFetch).toHaveBeenCalledTimes(2)
    } finally {
      unsubscribes.forEach(unsubscribe => unsubscribe())
      client.clear()
    }
  })

  it('does not restart interrupted metadata queries in a replacement workspace', async () => {
    const { client } = seed()
    const old = agent(client)
    const stale = deferred()
    const post = deferred()
    const fetchAgents = vi.fn(async () => { await stale.promise; return [old] })
    const observer = new QueryObserver(client, { queryKey: ['agents'], queryFn: fetchAgents, staleTime: Infinity })
    const unsubscribe = observer.subscribe(() => {})
    try {
      const refetch = client.invalidateQueries({ queryKey: ['agents'], exact: true })
      vi.mocked(apiFetch).mockReturnValueOnce(post.promise)
      const operation = readNotifications(client, { kind: 'all' })
      await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1))
      client.clear()
      client.setQueryData(['agents'], [{ slug: 'other-workspace', name: 'Other' }])
      post.resolve(response(state()))
      await operation
      stale.resolve(response())
      await refetch
      expect(fetchAgents).toHaveBeenCalledTimes(1)
      expect(client.getQueryData(['agents'])).toEqual([{ slug: 'other-workspace', name: 'Other' }])
      expect(client.getQueryState(['agents'])?.isInvalidated).toBe(false)
    } finally {
      unsubscribe()
      client.clear()
    }
  })

  it('preserves the original POST error if interrupted metadata recovery also fails', async () => {
    const { client } = seed()
    const old = agent(client)
    const stale = deferred()
    const fetchAgents = vi.fn()
      .mockImplementationOnce(async () => { await stale.promise; return [old] })
      .mockRejectedValueOnce(new Error('metadata offline'))
    const observer = new QueryObserver(client, { queryKey: ['agents'], queryFn: fetchAgents, staleTime: Infinity })
    const unsubscribe = observer.subscribe(() => {})
    try {
      const refetch = client.invalidateQueries({ queryKey: ['agents'], exact: true })
      vi.mocked(apiFetch).mockRejectedValueOnce(new Error('read offline'))
      await expect(readNotifications(client, { kind: 'all' })).rejects.toThrow('read offline')
      expect(fetchAgents).toHaveBeenCalledTimes(2)
      expect(client.getQueryState(['agents'])?.error).toMatchObject({ message: 'metadata offline' })
      stale.resolve(response())
      await refetch
    } finally {
      unsubscribe()
      client.clear()
    }
  })

  it('does not dispatch the POST if the workspace changes while cancellation settles', async () => {
    const { client } = seed()
    const cancelled = deferred()
    const cancelQueries = client.cancelQueries.bind(client)
    const cancel = vi.spyOn(client, 'cancelQueries').mockImplementationOnce(async filters => {
      await cancelQueries(filters)
      await cancelled.promise
    })
    const operation = readNotifications(client, { kind: 'all' })
    const rejected = expect(operation).rejects.toThrow('Workspace changed')
    await waitFor(() => expect(cancel).toHaveBeenCalledTimes(1))
    client.clear()
    client.setQueryData(['agents'], [{ slug: 'other-workspace' }])
    cancelled.resolve(response())
    await rejected
    expect(apiFetch).not.toHaveBeenCalled()
    expect(client.getQueryData(['agents'])).toEqual([{ slug: 'other-workspace' }])
  })

  it('does not invalidate a recreated query with the same key during recovery', async () => {
    const { client } = seed()
    const stale = deferred()
    const post = deferred()
    const key = ['agents', 'agent-a']
    const fetchAgent = vi.fn(async () => { await stale.promise; return agent(client) })
    const observer = new QueryObserver(client, { queryKey: key, queryFn: fetchAgent, staleTime: Infinity })
    const unsubscribe = observer.subscribe(() => {})
    try {
      const refetch = client.invalidateQueries({ queryKey: key, exact: true })
      vi.mocked(apiFetch).mockReturnValueOnce(post.promise)
      const operation = readNotifications(client, { kind: 'all' })
      await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1))
      client.removeQueries({ queryKey: key, exact: true })
      client.setQueryData(key, { ...agent(client), name: 'Replacement' })
      post.resolve(response(state()))
      await operation
      stale.resolve(response())
      await refetch
      expect(fetchAgent).toHaveBeenCalledTimes(1)
      expect(client.getQueryData(key)).toMatchObject({ name: 'Replacement' })
      expect(client.getQueryState(key)?.isInvalidated).toBe(false)
    } finally {
      unsubscribe()
      client.clear()
    }
  })

  it('clears the matching session preview and confirms remaining unread sessions', async () => {
    const { client } = seed()
    const pending = deferred()
    vi.mocked(apiFetch).mockReturnValueOnce(pending.promise)
    const operation = readNotifications(client, { kind: 'session', sessionId: 's1' })
    await waitFor(() => expect(agent(client).notificationPreview).toBeUndefined())
    expect(page(client).items[0].isRead).toBe(true)
    expect(client.getQueryData<ApiSession>(['session', 's1', 'a'])!.hasUnreadNotifications).toBe(false)
    pending.resolve(response(state('n2')))
    await operation
    expect(agent(client).notificationPreview).toBe('n2')
    expect(apiFetch).toHaveBeenCalledExactlyOnceWith('/api/notifications/read-by-session/s1', { method: 'POST' })
  })

  it.each([true, false])('does not dispatch a queued read to a newly selected workspace (readState: %s)', async (withReadState) => {
    const { client } = seed()
    const pending = deferred()
    vi.mocked(apiFetch).mockReturnValueOnce(pending.promise)
    const first = readNotifications(client, { kind: 'all' })
    const second = readNotifications(client, { kind: 'notification', id: 'n1' })
    const rejected = expect(second).rejects.toThrow('Workspace changed')
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1))
    client.clear()
    client.setQueryData(['agents'], [{ slug: 'other-workspace' }])
    pending.resolve(response(withReadState ? state() : undefined))
    await first
    await rejected
    expect(apiFetch).toHaveBeenCalledTimes(1)
    expect(client.getQueryData(['agents'])).toEqual([{ slug: 'other-workspace' }])
    expect(client.getQueryState(['agents'])?.isInvalidated).toBe(false)
  })

  it('does not resurrect a cleared workspace cache when a write fails', async () => {
    const { client } = seed()
    const pending = deferred()
    vi.mocked(apiFetch).mockReturnValueOnce(pending.promise)
    const operation = readNotifications(client, { kind: 'all' })
    const rejected = expect(operation).rejects.toThrow('offline')
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1))
    client.clear()
    pending.reject(new Error('offline'))
    await rejected
    expect(client.getQueryCache().getAll()).toHaveLength(0)
  })
})
