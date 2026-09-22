import { afterEach, describe, expect, it, vi } from 'vitest'
import { commentEvent, historyAction, notificationEvent } from './direct-events'
import type { DirectComment, DirectHistory, DirectIssue, DirectNotification } from './direct-schema'

const before = '2026-09-01T00:00:00.000Z'
const at = '2026-09-02T00:00:00.000Z'
const later = '2026-09-03T00:00:00.000Z'
const issue: DirectIssue = { id: 'issue', identifier: 'TES-1', title: 'Test', updatedAt: later, archivedAt: null, delegate: { id: 'app' }, state: { id: 'todo', name: 'Todo', type: 'unstarted' } }
const comment: DirectComment = { id: 'comment', body: 'Please help', createdAt: at, updatedAt: at, archivedAt: null, user: { id: 'human', app: false }, parent: null, issue }
const notification: DirectNotification = { id: 'notification', user: { id: 'app' }, type: 'issueCommentMention', createdAt: at, updatedAt: at, actor: { id: 'human', app: false }, comment, issue }
const history: DirectHistory = { id: 'history', createdAt: later, updatedAt: later, actor: { id: 'human', app: false }, fromDelegate: { id: 'app' }, toDelegate: null, fromState: null, toState: null, archived: null }
afterEach(() => vi.unstubAllGlobals())
describe('Linear direct event routing', () => {
  it('discovers a first mention without delegation and uses the same identity for replayed comments', () => {
    const mentioned = notificationEvent({ ...notification, issue: { ...issue, delegate: null } }, 'app')!
    const reply = commentEvent({ ...comment, issue: { ...issue, delegate: null } }, 'app', { threads: new Set(['comment']) })!
    expect(mentioned).toMatchObject({ id: 'comment:comment', sourceCommentId: 'comment', taskId: 'issue', kind: 'invocation', replyTarget: { commentId: 'comment' } })
    expect(reply.id).toBe(mentioned.id)
  })
  it('runs human replies in involved threads, retains other comments as context, and ignores self echoes', () => {
    const tracked = { threads: new Set(['root']) }
    expect(commentEvent({ ...comment, parent: { id: 'root' }, issue: { ...issue, delegate: null } }, 'app', tracked)).toMatchObject({ kind: 'invocation', sourceCommentId: 'comment', replyTarget: { commentId: 'root' } })
    expect(commentEvent({ ...comment, issue: { ...issue, delegate: null } }, 'app', tracked)).toMatchObject({ kind: 'context', id: 'comment-context:comment:' + at })
    expect(commentEvent({ ...comment, user: { id: 'app', app: true } }, 'app', tracked)).toBeNull()
    expect(commentEvent({ ...comment, archivedAt: later }, 'app', tracked)).toBeNull()
    expect(notificationEvent({ ...notification, actor: { id: 'app', app: true } }, 'app')).toBeNull()
  })
  it('keeps other apps as context and prevents two agents from invoking or answering each other', () => {
    const tracked = { threads: new Set(['human-root']) }
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
    expect(commentEvent({ ...comment, createdAt: before }, 'app', { threads: new Set() }, false)?.kind).toBe('context')
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
it.each(['cancel', 'archive', 'undelegate'])('only external %s edits stop work', change => {
  const update = { ...history, fromDelegate: change === 'undelegate' ? { id: 'app' } : null,
    toState: change === 'cancel' ? { id: 'cancel', name: 'Canceled', type: 'canceled' } : null,
    archived: change === 'archive' }
  expect(historyAction(update, issue, 'app', false)).toMatchObject({ type: 'stop' })
  expect(historyAction({ ...update, actor: { id: 'app', app: true } }, issue, 'app', false))
    .toMatchObject({ type: 'event', event: { kind: 'context' } })
})

it('ignores another recipient and treats edits to missed comments as context', () => {
  expect(notificationEvent({ ...notification, user: { id: 'someone-else' } }, 'app')).toBeNull()
  expect(commentEvent(comment, 'app', { threads: new Set() }, false)?.kind).toBe('context')
})
