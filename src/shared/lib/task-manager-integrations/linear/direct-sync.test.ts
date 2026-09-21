import { afterEach, describe, expect, it, vi } from 'vitest'
import { LinearClient } from './client'
import { collectDirectActions } from './direct-sync'
import { commentEvent, historyAction, notificationEvent } from './direct-events'
import type { DirectComment, DirectHistory, DirectIssue, DirectNotification } from './direct-schema'

const before = '2026-09-01T00:00:00.000Z'
const at = '2026-09-02T00:00:00.000Z'
const later = '2026-09-03T00:00:00.000Z'
const issue: DirectIssue = { id: 'issue', identifier: 'TES-1', title: 'Test', updatedAt: later, archivedAt: null, delegate: { id: 'app' }, state: { id: 'todo', name: 'Todo', type: 'unstarted' } }
const comment: DirectComment = { id: 'comment', body: 'Please help', createdAt: at, updatedAt: at, archivedAt: null, user: { id: 'human', app: false }, parent: null, issue }
const notification: DirectNotification = { id: 'notification', type: 'issueCommentMention', createdAt: at, updatedAt: at, actor: { id: 'human', app: false }, comment, issue }
const history: DirectHistory = { id: 'history', createdAt: later, updatedAt: later, actor: { id: 'human', app: false }, fromDelegate: { id: 'app' }, toDelegate: null, fromState: null, toState: null, archived: null }
const page = (nodes: unknown[], cursor: string | null = null) => ({ nodes, pageInfo: { hasNextPage: cursor !== null, endCursor: cursor } })
afterEach(() => vi.unstubAllGlobals())
describe('Linear direct event routing', () => {
  it('discovers a first mention without delegation and uses the same identity for replayed comments', () => {
    const mentioned = notificationEvent({ ...notification, issue: { ...issue, delegate: null } }, 'app')!
    const reply = commentEvent({ ...comment, issue: { ...issue, delegate: null } }, 'app', { since: at, threads: new Set(['comment']) })!
    expect(mentioned).toMatchObject({ id: 'comment:comment', sourceCommentId: 'comment', taskId: 'issue', kind: 'invocation', replyTarget: { commentId: 'comment' } })
    expect(reply.id).toBe(mentioned.id)
  })
  it('runs human replies in involved threads, retains other comments as context, and ignores self echoes', () => {
    const tracked = { since: at, threads: new Set(['root']) }
    expect(commentEvent({ ...comment, parent: { id: 'root' }, issue: { ...issue, delegate: null } }, 'app', tracked)).toMatchObject({ kind: 'invocation', sourceCommentId: 'comment', replyTarget: { commentId: 'root' } })
    expect(commentEvent({ ...comment, issue: { ...issue, delegate: null } }, 'app', tracked)).toMatchObject({ kind: 'context', id: 'comment-context:comment:' + at })
    expect(commentEvent({ ...comment, user: { id: 'app', app: true } }, 'app', tracked)).toBeNull()
    expect(commentEvent({ ...comment, archivedAt: later }, 'app', tracked)).toBeNull()
    expect(notificationEvent({ ...notification, actor: { id: 'app', app: true } }, 'app')).toBeNull()
  })
  it('keeps other apps as context and prevents two agents from invoking or answering each other', () => {
    const tracked = { since: before, threads: new Set(['human-root']) }
    for (const [author, receiver] of [['app-b', 'app-a'], ['app-a', 'app-b']]) {
      const reply = { ...comment, user: { id: author, app: true }, parent: { id: 'human-root' }, issue: { ...issue, delegate: { id: 'app-a' } } }
      expect(commentEvent(reply, receiver, tracked)).toMatchObject({ kind: 'context' })
      expect(notificationEvent({ ...notification, actor: reply.user, comment: reply }, receiver)).toBeNull()
      expect(historyAction({ ...history, actor: reply.user, fromDelegate: null, fromState: { id: 'todo' }, toState: { id: 'done', name: 'Done', type: 'completed' } }, issue, receiver, true))
        .toMatchObject({ type: 'event', event: { kind: 'context' } })
    }
    expect(commentEvent({ ...comment, user: null }, 'app', tracked)).toMatchObject({ kind: 'context' })
    expect(commentEvent(comment, 'app', tracked)).toMatchObject({ kind: 'invocation' })
  })
  it('uses the mention time when someone adds a mention to an older comment', () => {
    expect(notificationEvent({ ...notification, comment: { ...comment, createdAt: before } }, 'app'))
      .toMatchObject({ id: 'comment:comment', timestamp: at, kind: 'invocation' })
  })
  it('does not revive withdrawn delegation or old edited comments', () => {
    expect(notificationEvent({ ...notification, type: 'issueAssignedToYou', issue: { ...issue, delegate: null } }, 'app')).toBeNull()
    expect(commentEvent({ ...comment, createdAt: before }, 'app', { since: at, threads: new Set() })?.kind).toBe('context')
  })
  it('normalizes cancellation, opt-in status changes and self-authored changes', () => {
    expect(historyAction(history, issue, 'app', true)).toEqual({ type: 'stop', taskId: 'issue', timestamp: later })
    const status = { ...history, fromDelegate: null, fromState: { id: 'todo' }, toState: { id: 'done', name: 'Done', type: 'completed' } }
    expect(historyAction(status, issue, 'app', true)).toMatchObject({ type: 'event', event: { kind: 'status' } })
    expect(historyAction(status, issue, 'app', false)).toMatchObject({ type: 'event', event: { kind: 'context' } })
    expect(historyAction({ ...status, actor: { id: 'app', app: true } }, issue, 'app', true)).toMatchObject({ type: 'event', event: { kind: 'context' } })
    expect(historyAction({ ...status, toState: { id: 'cancel', name: 'Canceled', type: 'canceled' } }, issue, 'app', false)).toMatchObject({ type: 'stop' })
  })
})
function sync(tracked = new Map()) {
  return collectDirectActions({ client: new LinearClient(undefined, 'token'), appUserId: 'app', since: before, authorizedAt: before, tracked, runOnStatusChange: false, signal: new AbortController().signal })
}
describe('Linear direct recovery', () => {
  it('batches quiet issues and avoids fetching their unchanged histories', async () => {
    const fetchMock = vi.fn(async (_url, options) => {
      const { query } = JSON.parse(options.body)
      if (query.includes('notifications(')) return Response.json({ data: { notifications: page([]) } })
      if (query.includes('comments(')) return Response.json({ data: { comments: page([]) } })
      if (query.includes('issues(')) return Response.json({ data: { issues: page([issue, { ...issue, id: 'other' }]) } })
      throw new Error('Unchanged history should not be fetched')
    })
    vi.stubGlobal('fetch', fetchMock)
    expect(await collectDirectActions({ client: new LinearClient(undefined, 'token'), appUserId: 'app',
      since: '2026-09-04T00:00:00.000Z', authorizedAt: before, runOnStatusChange: false,
      tracked: new Map(['issue', 'other'].map(id => [id, { since: before, threads: new Set<string>() }])),
      signal: new AbortController().signal })).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('paginates notifications, comments and history, introducing the earliest mention before reading replies', async () => {
    const calls: Record<string, unknown>[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
      const { query, variables } = JSON.parse(options.body); calls.push(variables)
      if (query.includes('notifications(')) return Response.json({ data: { notifications: variables.after ? page([{ ...notification, id: 'earlier', comment: { ...comment, id: 'early', createdAt: before } }]) : page([notification], 'notifications-next') } })
      if (query.includes('comments(')) return Response.json({ data: { comments: variables.after ? page([comment]) : page([], 'comments-next') } })
      if (query.includes('issues(')) return Response.json({ data: { issues: page([issue]) } })
      return Response.json({ data: { issue: { ...issue, history: variables.after ? page([history]) : page([], 'history-next') } } })
    }))
    const actions = await sync()
    expect(calls.map(call => call.after)).toEqual([null, 'notifications-next', null, 'comments-next', null, null, 'history-next'])
    expect(calls[2].ids).toEqual(['issue'])
    expect(actions).toContainEqual({ type: 'stop', taskId: 'issue', timestamp: later })
    expect(actions.filter(action => action.type === 'event' && action.event.id === 'comment:comment')).toHaveLength(2) // Durable inbox deduplicates the two delivery sources.
  })
  it('does not start historical mentions that were merely marked read after installation', async () => {
    const fetchMock = vi.fn(async () => Response.json({ data: { notifications: page([{ ...notification, createdAt: '2020-01-01T00:00:00.000Z', comment: { ...comment, createdAt: '2020-01-01T00:00:00.000Z' } }]) } }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await sync()).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it('rejects incomplete pagination and transient errors without returning a partial batch', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: { notifications: { nodes: [notification], pageInfo: { hasNextPage: true, endCursor: null } } } })))
    await expect(sync()).rejects.toThrow('invalid pagination cursor')
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
      const { query } = JSON.parse(options.body)
      if (query.includes('notifications(')) return Response.json({ data: { notifications: page([notification]) } })
      return new Response(null, { status: 503 })
    }))
    await expect(sync()).rejects.toThrow('503')
  })
  it('distinguishes lost issue access from a failed GraphQL operation', async () => {
    const fetchMock = vi.fn(async (_url, options) => {
      const { query } = JSON.parse(options.body)
      if (query.includes('notifications(')) return Response.json({ data: { notifications: page([]) } })
      if (query.includes('comments(')) return Response.json({ data: { comments: page([]) } })
      if (query.includes('issues(')) return Response.json({ data: { issues: page([issue]) } })
      return Response.json({ errors: [{ message: 'Entity not found: Issue', extensions: { code: 'INPUT_ERROR' } }] })
    })
    vi.stubGlobal('fetch', fetchMock)
    await expect(sync(new Map([['issue', { since: at, threads: new Set() }]]))).rejects.toThrow('not found')
    fetchMock.mockImplementation(async (_url, options) => {
      const { query } = JSON.parse(options.body)
      if (query.includes('notifications(')) return Response.json({ data: { notifications: page([]) } })
      if (query.includes('comments(')) return Response.json({ data: { comments: page([]) } })
      if (query.includes('issues(')) return Response.json({ data: { issues: page([issue]) } })
      return Response.json({ errors: [{ extensions: { code: 'INTERNAL_SERVER_ERROR' } }] })
    })
    await expect(sync(new Map([['issue', { since: at, threads: new Set() }]]))).rejects.toThrow('could not complete')
  })
  it.each([403, 404, 503])('retries history HTTP %s without returning a cancellation', async status => {
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
      const { query } = JSON.parse(options.body)
      if (query.includes('notifications(')) return Response.json({ data: { notifications: page([]) } })
      if (query.includes('comments(')) return Response.json({ data: { comments: page([]) } })
      if (query.includes('issues(')) return Response.json({ data: { issues: page([issue]) } })
      return new Response(null, { status })
    }))
    await expect(sync(new Map([['issue', { since: at, threads: new Set() }]]))).rejects.toThrow()
  })

})

it.each(['cancel', 'archive', 'undelegate'])('only external %s edits stop work', change => {
  const update = { ...history, fromDelegate: change === 'undelegate' ? { id: 'app' } : null,
    toState: change === 'cancel' ? { id: 'cancel', name: 'Canceled', type: 'canceled' } : null,
    archived: change === 'archive' }
  expect(historyAction(update, issue, 'app', false)).toMatchObject({ type: 'stop' })
  expect(historyAction({ ...update, actor: { id: 'app', app: true } }, issue, 'app', false))
    .toMatchObject({ type: 'event', event: { kind: 'context' } })
})
