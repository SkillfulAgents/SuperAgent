import type { QueryClient, QueryKey } from '@tanstack/react-query'
import type { ApiAgent, ApiNotification, ApiSession } from '@shared/lib/types/api'
import { USER_ACTIONABLE_NOTIFICATION_TYPES } from '@shared/lib/notifications/notification-preferences'
import { notificationReadResponseSchema, type NotificationReadState, type NotificationReadTarget } from '@shared/lib/notifications/read-state-schema'
import { apiFetch } from './api'

type Page = { items: ApiNotification[]; total: number }
type Counts = { count: number; mentions?: number }
type CacheData = ApiAgent[] | ApiAgent | ApiSession[] | ApiSession | Page | Counts
const families = new Set(['agents', 'sessions', 'session', 'notifications'])
const revisions = new WeakMap<QueryClient, { count: number; agents: Map<string, number> }>()

/** An incoming event may precede its refetch; don't let an older POST erase it. */
export function noteNotificationChange(client: QueryClient, slug?: string): void {
  let revision = revisions.get(client)
  if (!revision) revisions.set(client, (revision = { count: 0, agents: new Map() }))
  revision.count++
  if (slug) revision.agents.set(slug, (revision.agents.get(slug) ?? 0) + 1)
}
const matches = (target: NotificationReadTarget, notification: Pick<ApiNotification, 'id' | 'sessionId'>) =>
  target.kind === 'all' || (target.kind === 'notification' ? notification.id === target.id : notification.sessionId === target.sessionId)

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

function optimisticRead(client: QueryClient, target: NotificationReadTarget) {
  const countRevision = revisions.get(client)?.count ?? 0
  const agentRevisions = new Map(revisions.get(client)?.agents)
  const agentUnchanged = (slug: string) => (revisions.get(client)?.agents.get(slug) ?? 0) === (agentRevisions.get(slug) ?? 0)
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
  const unread = [...notifications.values()].filter(n => USER_ACTIONABLE_NOTIFICATION_TYPES.some(type => type === n.type))
  const readAt = new Date()
  const snapshots = entries.map(query => {
    const before = query.state.data as CacheData
    const next = mapCache(query.queryKey, before, {
      notification: row => !row.isRead && matches(target, row) ? { ...row, isRead: true, readAt } : row,
      counts: counts => ({
        ...counts,
        count: target.kind === 'all' ? 0 : Math.max(0, counts.count - unread.length),
        ...(counts.mentions === undefined ? {} : { mentions: target.kind === 'all' ? 0 : Math.max(0, counts.mentions - unread.filter(n => n.type === 'session_mention').length) }),
      }),
      agent: agent => {
        const clearPreview = target.kind === 'all' || (agent.notificationPreviewSource && matches(target, agent.notificationPreviewSource))
        if (!clearPreview) return agent
        return {
          ...agent,
          notificationPreview: undefined,
          notificationPreviewSource: undefined,
          ...(target.kind === 'all' ? {
            // A notification read must not dismiss a personal reminder.
            hasUnreadNotifications: agent.markedUnreadSessionIds === undefined ? agent.hasUnreadNotifications : agent.markedUnreadSessionIds.length > 0,
            hasUnreadMention: false,
          } : {}),
        }
      },
      session: (session, slug) => {
        if (target.kind === 'notification' || (target.kind === 'session' && session.id !== target.sessionId)) return session
        if (session.hasUnreadNotifications === undefined && session.hasUnreadMention === undefined) return session
        const marked = agentFor(session.agentSlug ?? slug)?.markedUnreadSessionIds
        return {
          ...session,
          hasUnreadNotifications: marked === undefined ? session.hasUnreadNotifications : marked.includes(session.id),
          hasUnreadMention: false,
        }
      },
    })
    client.setQueryData(query.queryKey, next)
    return { query, before, after: query.state.data as CacheData, updateCount: query.state.dataUpdateCount }
  })

  return {
    rollback() {
      for (const { query, before, after } of snapshots) {
        // Authentication/workspace changes can remove the cache while the POST is in flight.
        if (client.getQueryCache().get(query.queryHash) !== query) continue
        client.setQueryData(query.queryKey, current => undo(current, before, after))
      }
    },
    confirm(state: NotificationReadState) {
      for (const { query, after, updateCount } of snapshots) {
        if (client.getQueryCache().get(query.queryHash) !== query) continue
        const previousAgents = Array.isArray(after) ? after as ApiAgent[] : 'slug' in after ? [after as ApiAgent] : []
        const previousSessions = Array.isArray(after) ? after as ApiSession[] : 'id' in after ? [after as ApiSession] : []
        client.setQueryData<CacheData>(query.queryKey, current => current && mapCache(query.queryKey, current, {
          notification: row => row,
          counts: counts => query.state.dataUpdateCount === updateCount && (revisions.get(client)?.count ?? 0) === countRevision
            ? { count: state.count, mentions: state.mentions } : counts,
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
  const run = async () => {
    if (workspaceQuery && client.getQueryCache().get(workspaceQuery.queryHash) !== workspaceQuery) {
      throw new Error('Workspace changed before notification read')
    }
    // Cancel stale refetches, but let an initial load without cached data finish.
    await client.cancelQueries({ predicate: query => query.state.data != null && families.has(String(query.queryKey[0])) })
    const optimistic = optimisticRead(client, target)
    const path = target.kind === 'all' ? 'read-all' : target.kind === 'session'
      ? `read-by-session/${encodeURIComponent(target.sessionId)}` : `${encodeURIComponent(target.id)}/read`
    try {
      const response = await apiFetch(`/api/notifications/${path}`, { method: 'POST' })
      if (!response.ok) throw new Error('Failed to mark notifications as read')
      const result = notificationReadResponseSchema.parse(await response.json())
      if (result.readState) optimistic.confirm(result.readState)
      return result
    } catch (error) {
      optimistic.rollback()
      throw error
    }
  }
  const result = (readQueues.get(client) ?? Promise.resolve()).then(run, run)
  readQueues.set(client, result)
  return result
}
