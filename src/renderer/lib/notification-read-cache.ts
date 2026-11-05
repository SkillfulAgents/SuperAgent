import { v4 as uuid } from 'uuid'
import { notifyManager, replaceEqualDeep, type Query, type QueryClient, type QueryKey } from '@tanstack/react-query'
import type { ApiAgent, ApiNotification, ApiSession } from '@shared/lib/types/api'
import { USER_ACTIONABLE_NOTIFICATION_TYPES } from '@shared/lib/notifications/notification-preferences'
import { NOTIFICATION_TYPES, type NotificationCounts } from '@shared/lib/notifications/notification-filters'
import { notificationReadResponseSchema, type NotificationReadState, type NotificationReadTarget } from '@shared/lib/notifications/read-state-schema'
import { NOTIFICATION_CLIENT_HEADER } from '@shared/lib/notifications/notification-change-schema'
import { apiFetch } from './api'

type Page = { items: ApiNotification[]; total: number }
type Counts = NotificationCounts
type CacheData = ApiAgent[] | ApiAgent | ApiSession[] | ApiSession | Page | Counts
const families = new Set(['agents', 'sessions', 'session', 'notifications'])
const revisions = new WeakMap<QueryClient, { count: number; allAgents: number; agents: Map<string, number> }>()
const clientIds = new WeakMap<QueryClient, string>()

export function notificationClientId(client: QueryClient): string {
  let id = clientIds.get(client)
  if (!id) clientIds.set(client, (id = uuid()))
  return id
}

/** An incoming event may precede its refetch; don't let an older POST erase it. */
export function noteNotificationChange(client: QueryClient, slug?: string): void {
  let revision = revisions.get(client)
  if (!revision) revisions.set(client, (revision = { count: 0, allAgents: 0, agents: new Map() }))
  revision.count++
  if (slug) revision.agents.set(slug, (revision.agents.get(slug) ?? 0) + 1)
  else revision.allAgents++
}

/** A write without a full projection must refresh every notification surface. */
export function invalidateNotificationCaches(client: QueryClient, slug?: string): void {
  noteNotificationChange(client, slug)
  for (const family of families) client.invalidateQueries({ queryKey: [family] })
}
/** Read-all with no type filter: every row, so counts and flags can go straight to zero. */
const readsEverything = (target: NotificationReadTarget) => target.kind === 'all' && !target.types
// A row without a type (an agent's preview source) can't be matched against a
// filtered read-all, so it is left for the server's confirmation to settle.
const matches = (target: NotificationReadTarget, notification: Pick<ApiNotification, 'id' | 'sessionId'> & { type?: ApiNotification['type'] }) =>
  target.kind === 'all'
    ? !target.types || (notification.type !== undefined && target.types.includes(notification.type))
    : target.kind === 'notification' ? notification.id === target.id : notification.sessionId === target.sessionId

function optimisticCounts(counts: Counts, target: NotificationReadTarget, matched: ApiNotification[]): Counts {
  const types = counts.types && { ...counts.types }
  if (types) {
    for (const type of NOTIFICATION_TYPES) {
      types[type] = {
        ...types[type],
        unread: target.kind === 'all' && (!target.types || target.types.includes(type))
          ? 0
          : Math.max(0, types[type].unread - matched.filter(row => row.type === type).length),
      }
    }
  }
  const actionable = matched.filter(row => USER_ACTIONABLE_NOTIFICATION_TYPES.some(type => type === row.type))
  return {
    ...counts,
    ...(types && { types }),
    count: types
      ? USER_ACTIONABLE_NOTIFICATION_TYPES.reduce((sum, type) => sum + types[type].unread, 0)
      : readsEverything(target) ? 0 : Math.max(0, counts.count - actionable.length),
    ...(counts.mentions === undefined ? {} : {
      mentions: target.kind === 'all' && (!target.types || target.types.includes('session_mention'))
        ? 0 : Math.max(0, counts.mentions - matched.filter(row => row.type === 'session_mention').length),
    }),
  }
}

function mapCache(key: QueryKey, data: CacheData, maps: {
  agent: (row: ApiAgent) => ApiAgent
  session: (row: ApiSession, slug: string) => ApiSession
  notification: (row: ApiNotification) => ApiNotification
  counts: (counts: Counts) => Counts
}): CacheData {
  if (key[0] === 'agents') {
    if (key.length === 1 && Array.isArray(data)) return (data as ApiAgent[]).map(maps.agent)
    if (key.length === 2 && 'slug' in data) return maps.agent(data as ApiAgent)
  }
  if (key[0] === 'sessions' && Array.isArray(data)) return (data as ApiSession[]).map(row => maps.session(row, String(key[1])))
  if (key[0] === 'session' && 'id' in data) return maps.session(data as ApiSession, String(key[2]))
  if (key[0] === 'notifications') {
    if ('items' in data) return { ...data, items: data.items.map(maps.notification) }
    if (key[1] === 'unread-count' && 'count' in data) return maps.counts(data)
  }
  return data
}

const agentStamp = (a: ApiAgent) => JSON.stringify([a.hasUnreadNotifications, a.hasUnreadMention, a.hasSessionsAwaitingInput, a.notificationPreview, a.notificationPreviewSource, a.markedUnreadSessionIds])
const sessionStamp = (s: ApiSession) => JSON.stringify([s.hasUnreadNotifications, s.hasUnreadMention])

/** Restore just this write's changes. New rows and unrelated/newer fields survive. */
function undo(current: unknown, before: unknown, after: unknown): unknown {
  if (Object.is(before, after)) return current
  if (Object.is(current, after)) return before
  if (!current || !before || !after || typeof current !== 'object' || typeof before !== 'object' || typeof after !== 'object') return current
  if (Array.isArray(current) && Array.isArray(before) && Array.isArray(after)) {
    const id = (row: Record<string, unknown>) => row.id ?? row.slug
    return current.map(row => {
      if (!row || typeof row !== 'object' || id(row) === undefined) return row
      return undo(row, before.find(old => id(old) === id(row)), after.find(old => id(old) === id(row)))
    })
  }
  if (Array.isArray(current) || Array.isArray(before) || Array.isArray(after)) return current
  const result = { ...current } as Record<string, unknown>
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    result[key] = undo(result[key], (before as Record<string, unknown>)[key], (after as Record<string, unknown>)[key])
  }
  return result
}

/** A notification projection does not refresh the rest of this cached record. */
function patchCache(client: QueryClient, query: Query, value: unknown) {
  const next = replaceEqualDeep(query.state.data, value)
  if (next === query.state.data) return
  const { dataUpdatedAt, isInvalidated } = query.state
  notifyManager.batch(() => {
    // Keep Query's manual-write bookkeeping so cancelling a concurrent fetch
    // retains this patch, without renewing unrelated metadata's freshness.
    client.setQueryData(query.queryKey, next, { updatedAt: dataUpdatedAt })
    if (isInvalidated) query.invalidate()
  })
}

/** Give metadata recovery a short turn in the write queue, never an unbounded one. */
async function refreshQueries(client: QueryClient, queries: Set<Query>) {
  // invalidateQueries does not restart an initial load with no data. That
  // request may have captured the state before the write committed too.
  await client.cancelQueries({ predicate: query => queries.has(query) && query.state.data === undefined })
  const refreshing = client.invalidateQueries({ predicate: query => queries.has(query) })
  const generations = new Map([...queries].filter(query => query.state.fetchStatus !== 'idle' && query.promise)
    .map(query => [query, query.promise]))
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const expired = await Promise.race([
      refreshing.then(() => false),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(true), 1000) }),
    ])
    if (!expired) return
    // Only cancel our exact fetch generation. A newer SSE refetch or a query
    // recreated in another workspace must survive this deadline.
    const ownsFetch = (query: Query) => generations.has(query) && generations.get(query) === query.promise
    const pending = new Set([...generations.keys()].filter(query => ownsFetch(query) && query.state.fetchStatus !== 'idle'))
    await client.cancelQueries({ predicate: query => pending.has(query) && ownsFetch(query) })
    for (const query of pending) {
      if (client.getQueryCache().get(query.queryHash) === query && ownsFetch(query)) query.invalidate()
    }
  } finally {
    clearTimeout(timer)
  }
}

function optimisticRead(client: QueryClient, target: NotificationReadTarget) {
  const countRevision = revisions.get(client)?.count ?? 0
  const allAgentsRevision = revisions.get(client)?.allAgents ?? 0
  const agentRevisions = new Map(revisions.get(client)?.agents)
  const agentUnchanged = (slug: string) => (revisions.get(client)?.allAgents ?? 0) === allAgentsRevision
    && (revisions.get(client)?.agents.get(slug) ?? 0) === (agentRevisions.get(slug) ?? 0)
  const entries = client.getQueryCache().findAll({ predicate: q => families.has(String(q.queryKey[0])) })
    .filter(q => q.state.data != null)
  const agents = client.getQueryData<ApiAgent[]>(['agents']) ?? []
  const agentFor = (slug: string) => agents.find(a => a.slug === slug || a.displaySlug === slug)
    ?? client.getQueryData<ApiAgent>(['agents', slug])
  const notifications = new Map<string, ApiNotification>()
  for (const query of entries) {
    const data = query.state.data as CacheData
    if (query.queryKey[0] === 'notifications' && 'items' in data) {
      for (const row of data.items) if (!row.isRead && matches(target, row)) notifications.set(row.id, row)
    }
  }
  const unread = [...notifications.values()]
  const readAt = new Date()
  const snapshots = entries.map(query => {
    const before = query.state.data as CacheData
    const next = mapCache(query.queryKey, before, {
      notification: row => !row.isRead && matches(target, row) ? { ...row, isRead: true, readAt } : row,
      counts: counts => optimisticCounts(counts, target, unread),
      agent: agent => {
        const clearPreview = readsEverything(target) || (target.kind !== 'all' && agent.notificationPreviewSource && matches(target, agent.notificationPreviewSource))
        if (!clearPreview) return agent
        return {
          ...agent,
          notificationPreview: undefined,
          notificationPreviewSource: undefined,
          ...(readsEverything(target) ? {
            // A notification read must not dismiss a personal reminder.
            hasUnreadNotifications: agent.markedUnreadSessionIds === undefined ? agent.hasUnreadNotifications : agent.markedUnreadSessionIds.length > 0,
            hasUnreadMention: false,
          } : {}),
        }
      },
      session: (session, slug) => {
        // A filtered read-all can leave other types unread in a session; confirm() settles it.
        if (target.kind === 'notification' || (target.kind === 'all' && target.types) || (target.kind === 'session' && session.id !== target.sessionId)) return session
        if (session.hasUnreadNotifications === undefined && session.hasUnreadMention === undefined) return session
        const marked = agentFor(session.agentSlug ?? slug)?.markedUnreadSessionIds
        return {
          ...session,
          hasUnreadNotifications: marked === undefined ? session.hasUnreadNotifications : marked.includes(session.id),
          hasUnreadMention: false,
        }
      },
    })
    patchCache(client, query, next)
    return { query, before, after: query.state.data as CacheData, updateCount: query.state.dataUpdateCount }
  })

  return {
    recoveryQueries() {
      // A query can mount, finish its initial load, or refetch while the POST
      // is pending. Its snapshot may predate the write. Reconcile after commit
      // instead of letting it silently override the optimistic read.
      return client.getQueryCache().findAll({ predicate: query => families.has(String(query.queryKey[0])) })
        .filter(query => {
          const snapshot = snapshots.find(entry => entry.query === query)
          return !snapshot || query.state.dataUpdateCount !== snapshot.updateCount
            || query.state.fetchStatus !== 'idle' || (revisions.get(client)?.count ?? 0) !== countRevision
        })
    },
    refresh() {
      // Older servers (or a failed post-write projection) cannot confirm the
      // remaining unread state. Refresh only this workspace's existing queries.
      return refreshQueries(client, new Set(client.getQueryCache().findAll({
        predicate: query => families.has(String(query.queryKey[0])),
      })))
    },
    rollback() {
      for (const { query, before, after } of snapshots) {
        // Authentication/workspace changes can remove the cache while the POST is in flight.
        if (client.getQueryCache().get(query.queryHash) !== query) continue
        patchCache(client, query, undo(query.state.data, before, after))
      }
    },
    confirm(state: NotificationReadState) {
      for (const { query, after, updateCount } of snapshots) {
        if (client.getQueryCache().get(query.queryHash) !== query) continue
        const previousAgents = Array.isArray(after) ? after as ApiAgent[] : 'slug' in after ? [after as ApiAgent] : []
        const previousSessions = Array.isArray(after) ? after as ApiSession[] : 'id' in after ? [after as ApiSession] : []
        const current = query.state.data as CacheData | undefined
        patchCache(client, query, current && mapCache(query.queryKey, current, {
          notification: row => row,
          counts: counts => query.state.dataUpdateCount === updateCount && (revisions.get(client)?.count ?? 0) === countRevision
            ? { ...counts, count: state.count, mentions: state.mentions, ...(state.types && { types: state.types }) } : counts,
          agent: agent => {
            const prior = previousAgents.find(a => a.slug === agent.slug)
            const summary = state.agents.find(a => a.slug === agent.slug)
            // A notification/refetch arriving during the POST wins over an older response.
            if (!prior || !summary || !agentUnchanged(agent.slug) || agentStamp(agent) !== agentStamp(prior)) return agent
            return {
              ...agent,
              hasUnreadNotifications: summary.hasUnreadNotifications,
              hasUnreadMention: summary.hasUnreadMention,
              notificationPreview: summary.notificationPreview,
              notificationPreviewSource: summary.notificationPreviewSource,
              markedUnreadSessionIds: summary.markedUnreadSessionIds,
            }
          },
          session: (session, slug) => {
            const prior = previousSessions.find(s => s.id === session.id)
            const canonical = agentFor(session.agentSlug ?? slug)?.slug ?? session.agentSlug ?? slug
            const summary = state.agents.find(a => a.slug === canonical)
            if (!prior || !summary || !agentUnchanged(canonical) || sessionStamp(session) !== sessionStamp(prior)) return session
            if (session.hasUnreadNotifications === undefined && session.hasUnreadMention === undefined) return session
            return { ...session, hasUnreadNotifications: summary.unreadSessionIds.includes(session.id), hasUnreadMention: summary.mentionedSessionIds.includes(session.id) }
          },
        }))
      }
    },
  }
}

// Serialize read writes per workspace client. A second write starts from the
// first's confirmed/rolled-back cache, so overlapping snapshots cannot undo it.
const readQueues = new WeakMap<QueryClient, Promise<unknown>>()

export function readNotifications(client: QueryClient, target: NotificationReadTarget) {
  const workspaceQuery = client.getQueryCache().find({ queryKey: ['agents'], exact: true })
  const isCurrentWorkspace = () => !workspaceQuery || client.getQueryCache().get(workspaceQuery.queryHash) === workspaceQuery
  const run = async () => {
    if (!isCurrentWorkspace()) {
      throw new Error('Workspace changed before notification read')
    }
    // Agent/session refetches also carry metadata, such as an async agent rename.
    // Remember interrupted query objects so the read's notification-only patch
    // cannot leave their older metadata marked fresh after cancelling the GET.
    const cached = client.getQueryCache().findAll({ predicate: query =>
      query.state.data != null && families.has(String(query.queryKey[0])),
    })
    const toRefresh = new Set(cached.filter(query => query.state.fetchStatus !== 'idle'))
    const invalidated = cached.filter(query => query.state.isInvalidated)
    // Cancel stale refetches, but let an initial load without cached data finish.
    await client.cancelQueries({ predicate: query => query.state.data != null && families.has(String(query.queryKey[0])) })
    if (!isCurrentWorkspace()) {
      throw new Error('Workspace changed before notification read')
    }
    // Query's manual-write cancellation snapshot can precede an invalidation.
    // Keep that stale flag when cancellation restores the patched data.
    for (const query of invalidated) {
      if (client.getQueryCache().get(query.queryHash) === query) query.invalidate()
    }
    const optimistic = optimisticRead(client, target)
    let refreshed = false
    const path = target.kind === 'all' ? 'read-all' : target.kind === 'session'
      ? `read-by-session/${encodeURIComponent(target.sessionId)}` : `${encodeURIComponent(target.id)}/read`
    try {
      const response = await apiFetch(`/api/notifications/${path}`, {
        method: 'POST',
        headers: {
          [NOTIFICATION_CLIENT_HEADER]: notificationClientId(client),
          ...(target.kind === 'all' && target.types ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(target.kind === 'all' && target.types ? { body: JSON.stringify({ types: target.types }) } : {}),
      })
      if (!response.ok) throw new Error('Failed to mark notifications as read')
      const result = notificationReadResponseSchema.parse(await response.json())
      if (!isCurrentWorkspace()) return result
      if (result.readState) {
        // Inspect before confirm() itself changes the query update counts.
        for (const query of optimistic.recoveryQueries()) toRefresh.add(query)
        optimistic.confirm(result.readState)
      } else {
        await optimistic.refresh()
        refreshed = true
      }
      return result
    } catch (error) {
      optimistic.rollback()
      // A lost response can follow a committed write. Roll back immediately,
      // then reconcile instead of pinning the speculative rollback as truth.
      if (isCurrentWorkspace()) {
        await optimistic.refresh()
        refreshed = true
      }
      throw error
    } finally {
      if (!refreshed && toRefresh.size && isCurrentWorkspace()) {
        // Refresh interrupted queries still in this cache after the POST
        // has settled so an old unread projection cannot undo the write. Active
        // queries reload now; inactive ones remain stale until next observed.
        // Serialize a bounded recovery before the next write. On timeout its
        // GET cannot publish an obsolete unread projection after that write.
        await refreshQueries(client, toRefresh)
      }
    }
  }
  const result = (readQueues.get(client) ?? Promise.resolve()).then(run, run)
  readQueues.set(client, result)
  return result
}
