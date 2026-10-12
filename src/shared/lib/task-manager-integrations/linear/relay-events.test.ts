import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { RelayEvent } from '../../webhook-relay'
import type { LinearClient } from './client'
import { checkLinearWebhook, linearWebhookEvents, type LinearWebhookBody } from './relay-events'

const secret = 'lin_wh_secret'
const at = Date.parse('2026-09-24T10:00:00.000Z')

function delivery(body: object | string, options: { secret?: string; receivedAt?: number; encoding?: 'utf8' | 'base64'; kind?: string; signature?: string | null } = {}): RelayEvent {
  const raw = typeof body === 'string' ? body : JSON.stringify(body)
  const signature = options.signature === undefined ? createHmac('sha256', options.secret ?? secret).update(raw).digest('hex') : options.signature
  return {
    id: 'whe_1', endpointId: 'whep_linear', type: 'CUSTOM_WEBHOOK', createdAt: new Date(at).toISOString(),
    payload: {
      kind: options.kind ?? 'event', verified: false, method: 'POST',
      headers: { 'content-type': 'application/json', ...(signature ? { 'linear-signature': signature } : {}) },
      body: options.encoding === 'base64' ? Buffer.from(raw).toString('base64') : raw,
      body_encoding: options.encoding ?? 'utf8',
      received_at: new Date(options.receivedAt ?? at).toISOString(),
    },
  }
}
const notificationBody = {
  type: 'AppUserNotification', action: 'issueAssignedToYou', createdAt: new Date(at).toISOString(), webhookTimestamp: at,
  appUserId: 'app', organizationId: 'org', oauthClientId: 'client', webhookId: 'hook', notification: { id: 'notif-1', type: 'issueAssignedToYou' },
}

describe('checkLinearWebhook', () => {
  it('accepts a delivery signed with the app secret, raw or base64', () => {
    expect(checkLinearWebhook(delivery(notificationBody), secret)).toMatchObject({ ok: true, body: { type: 'AppUserNotification' } })
    expect(checkLinearWebhook(delivery(notificationBody, { encoding: 'base64' }), secret)).toMatchObject({ ok: true })
  })

  it('verifies the exact bytes, not a re-serialization', () => {
    const spaced = JSON.stringify(notificationBody, null, 2)
    expect(checkLinearWebhook(delivery(spaced), secret)).toMatchObject({ ok: true })
  })

  it('rejects another secret, a missing signature and handshakes', () => {
    expect(checkLinearWebhook(delivery(notificationBody, { secret: 'other' }), secret)).toEqual({ ok: false, reason: 'signature' })
    expect(checkLinearWebhook(delivery(notificationBody, { signature: null }), secret)).toEqual({ ok: false, reason: 'not_linear' })
    expect(checkLinearWebhook(delivery(notificationBody, { kind: 'handshake' }), secret)).toEqual({ ok: false, reason: 'handshake' })
  })

  it('judges freshness by when the relay received it, not by when it is claimed', () => {
    vi.useFakeTimers(); vi.setSystemTime(at + 6 * 60 * 60_000)
    try {
      expect(checkLinearWebhook(delivery(notificationBody, { receivedAt: at + 30_000 }), secret)).toMatchObject({ ok: true })
      expect(checkLinearWebhook(delivery(notificationBody, { receivedAt: at + 61_000 }), secret)).toEqual({ ok: false, reason: 'stale' })
    } finally { vi.useRealTimers() }
  })
})

const issue = { id: 'issue', identifier: 'TES-1', title: 'Test', updatedAt: new Date(at).toISOString(), archivedAt: null, delegate: null, state: { id: 'todo', name: 'Todo', type: 'unstarted' } }
function history(id: string, offsetMs: number, change: Record<string, unknown>) {
  const time = new Date(at + offsetMs).toISOString()
  return { id, createdAt: time, updatedAt: time, actor: { id: 'human', app: false }, fromDelegate: null, toDelegate: null, fromState: null, toState: null, archived: null, ...change }
}
function client(responses: Record<string, unknown>) {
  const request = vi.fn(async (query: string, variables: { id: string }, schema: z.ZodType) => {
    const key = Object.keys(responses).find((name) => query.includes(`${name}(id:$id)`))
    if (!key) throw new Error(`unexpected query ${query}`)
    return schema.parse({ [key]: responses[key] })
  })
  return { request, client: { request } as unknown as LinearClient }
}
const body = (value: object) => value as LinearWebhookBody

describe('linearWebhookEvents', () => {
  it('reads an app notification back as the subscription event direct mode receives', async () => {
    const notification = { id: 'notif-1', type: 'issueAssignedToYou', createdAt: issue.updatedAt, updatedAt: issue.updatedAt, user: { id: 'app' }, actor: { id: 'human', app: false }, issue, comment: null }
    const { client: linear, request } = client({ notification })

    expect(await linearWebhookEvents(linear, body(notificationBody), 'app', () => false)).toEqual([{ type: 'notificationCreated', data: notification }])
    expect(request.mock.calls[0][1]).toEqual({ id: 'notif-1' })
    expect(await linearWebhookEvents(linear, body({ ...notificationBody, appUserId: 'another-app' }), 'app', () => false)).toEqual([])
  })

  it('maps comment creates and edits, and ignores removals without a request', async () => {
    const comment = { id: 'c1', body: 'Hi', createdAt: issue.updatedAt, updatedAt: issue.updatedAt, archivedAt: null, user: { id: 'human', app: false }, parent: null, issue }
    const { client: linear, request } = client({ comment })
    const base = { type: 'Comment', createdAt: issue.updatedAt, webhookTimestamp: at, data: { id: 'c1', issueId: 'issue', userId: 'human' } }
    const events = (value: object) => linearWebhookEvents(linear, body(value), 'app', () => false)

    expect(await events({ ...base, action: 'create' })).toEqual([{ type: 'commentCreated', data: comment }])
    expect(await events({ ...base, action: 'update' })).toEqual([{ type: 'commentUpdated', data: comment }])
    expect(await events({ ...base, action: 'remove' })).toEqual([])
    // Its own replies, and comments on projects or documents, cost no request.
    expect(await events({ ...base, action: 'create', data: { ...base.data, userId: 'app' } })).toEqual([])
    expect(await events({ ...base, action: 'create', data: { id: 'c2', issueId: null, userId: 'human' } })).toEqual([])
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('picks the history entry an issue update reports: same kind of change, around the same time', async () => {
    const delegation = history('h-delegate', 400, { fromDelegate: { id: 'app' } })
    const title = history('h-title', 300, {})
    const earlier = history('h-old', -60_000, { fromDelegate: { id: 'app' } })
    const other = history('h-other', 200, { fromDelegate: { id: 'someone' } })
    const status = history('h-status', 500, { fromState: { id: 'todo' }, toState: { id: 'done', name: 'Done', type: 'completed' } })
    const { client: linear } = client({ issue: { ...issue, newest: { nodes: [status, delegation, other, title] }, oldest: { nodes: [earlier, title, delegation] } } })
    const update = { type: 'Issue', action: 'update', createdAt: new Date(at).toISOString(), webhookTimestamp: at, data: { id: 'issue' } }

    const events = await linearWebhookEvents(linear, body({ ...update, updatedFrom: { delegateId: 'app', updatedAt: 'x' } }), 'app', () => false)

    expect(events).toEqual([{ type: 'issueHistoryCreated', data: { ...delegation, issue } }])
  })

  it('reads issue changes only for issues the app is working on or was delegated', async () => {
    const status = history('h-status', 0, { fromState: { id: 'todo' }, toState: { id: 'done', name: 'Done', type: 'completed' } })
    const { client: linear, request } = client({ issue: { ...issue, newest: { nodes: [status] }, oldest: { nodes: [] } } })
    const update = { type: 'Issue', action: 'update', createdAt: new Date(at).toISOString(), webhookTimestamp: at, updatedFrom: { stateId: 'todo' } }

    expect(await linearWebhookEvents(linear, body({ ...update, data: { id: 'issue', delegateId: 'someone', stateId: 'done' } }), 'app', () => false)).toEqual([])
    expect(request).not.toHaveBeenCalled()
    expect(await linearWebhookEvents(linear, body({ ...update, data: { id: 'issue', delegateId: 'app', stateId: 'done' } }), 'app', () => false)).toHaveLength(1)
    expect(await linearWebhookEvents(linear, body({ ...update, data: { id: 'issue', delegateId: null, stateId: 'done' } }), 'app', id => id === 'issue')).toHaveLength(1)
  })

  it('never replays a neighbouring change of the same kind', async () => {
    // Withdrawn at T0, delegated again five seconds later: the second
    // webhook must only report the second change, not stop the task again.
    const withdrawn = history('h-withdrawn', 0, { fromDelegate: { id: 'app' }, toDelegate: null })
    const delegated = history('h-delegated', 5_000, { fromDelegate: null, toDelegate: { id: 'app' } })
    const { client: linear } = client({ issue: { ...issue, newest: { nodes: [delegated, withdrawn] }, oldest: { nodes: [withdrawn, delegated] } } })
    const redelegation = { type: 'Issue', action: 'update', createdAt: new Date(at + 5_000).toISOString(), webhookTimestamp: at, data: { id: 'issue', delegateId: 'app' }, updatedFrom: { delegateId: null } }

    const events = await linearWebhookEvents(linear, body(redelegation), 'app', () => false)

    expect(events.map((event) => event.type === 'issueHistoryCreated' && event.data.id)).toEqual(['h-delegated'])
  })

  it('skips issue updates the direct transport would only ever treat as context', async () => {
    const { client: linear, request } = client({})
    const update = { type: 'Issue', action: 'update', createdAt: new Date(at).toISOString(), webhookTimestamp: at, data: { id: 'issue' } }

    expect(await linearWebhookEvents(linear, body({ ...update, updatedFrom: { title: 'Old', updatedAt: 'x' } }), 'app', () => true)).toEqual([])
    expect(await linearWebhookEvents(linear, body({ type: 'Reaction', action: 'create', createdAt: '', webhookTimestamp: at }), 'app', () => true)).toEqual([])
    expect(request).not.toHaveBeenCalled()
  })
})
