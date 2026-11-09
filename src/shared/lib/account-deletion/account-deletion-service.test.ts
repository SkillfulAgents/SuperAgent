import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import { DEFAULT_AMPLITUDE_KEY } from '@shared/lib/analytics/constants'
import {
  AccountDeletionDeliveryError,
  deletionEventPlatform,
  getAccountDeletionRequest,
  requestAccountDeletion,
  sanitizeWorkspaceUrl,
} from './account-deletion-service'

// The request is a host record in the app database: a fresh test database per test.
let handle: TestDatabase
let testDb: TestDatabase['db']
vi.mock('@shared/lib/db', () => ({ get db() { return testDb } }))

const ACCOUNT = {
  userId: '7b0f1c9e-1111-4222-8333-444455556666',
  workspaceUrl: 'https://platform.example',
  tenantId: 'tenant-1',
}

function acknowledged() {
  return new Response(JSON.stringify({ code: 200, events_ingested: 1 }), { status: 200 })
}

/** A fetch that answers with `responses` in order and records what it was sent. */
function fakeFetch(...responses: Array<Response | Error>) {
  const bodies: Array<Record<string, any>> = []
  const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)))
    const next = responses.shift()
    if (!next) throw new Error('no response left')
    if (next instanceof Error) throw next
    return next
  }) as unknown as typeof fetch
  return { fetchImpl, bodies, calls: fetchImpl as unknown as ReturnType<typeof vi.fn> }
}

describe('account deletion request', () => {
  beforeEach(async () => {
    handle = await createTestDatabase()
    testDb = handle.db
  })

  afterEach(async () => {
    await handle.close()
  })

  it('sends the event the support consumer subscribes to, in the iOS app’s contract', async () => {
    const { fetchImpl, bodies, calls } = fakeFetch(acknowledged())

    const record = await requestAccountDeletion(ACCOUNT, { platform: 'macos', fetch: fetchImpl, now: () => 1_700_000_000_000 })

    expect(calls.mock.calls[0][0]).toBe('https://api2.amplitude.com/2/httpapi')
    expect(bodies[0]).toEqual({
      api_key: DEFAULT_AMPLITUDE_KEY,
      events: [
        {
          event_type: 'account_deletion_requested',
          user_id: ACCOUNT.userId,
          time: 1_700_000_000_000,
          insert_id: record.requestId,
          session_id: -1,
          platform: 'macos',
          event_properties: {
            request_id: record.requestId,
            event_id: record.requestId,
            event_version: 1,
            workspace_url: 'https://platform.example/',
            tenantId: 'tenant-1',
            source: 'client',
            surface: 'app',
            platform: 'macos',
          },
          groups: { tenantId: 'tenant-1' },
        },
      ],
      options: { min_id_length: 1 },
    })
    expect(record.acceptedAt).toBe(1_700_000_000_000)
    expect((await getAccountDeletionRequest(ACCOUNT.userId))?.acceptedAt).toBe(1_700_000_000_000)
  })

  it('leaves the tenant out when there is none', async () => {
    const { fetchImpl, bodies } = fakeFetch(acknowledged())

    await requestAccountDeletion({ ...ACCOUNT, tenantId: null }, { platform: 'macos', fetch: fetchImpl })

    expect(bodies[0].events[0]).not.toHaveProperty('groups')
    expect(bodies[0].events[0].event_properties).not.toHaveProperty('tenantId')
  })

  it('keeps the request when delivery fails, and a retry sends the same one', async () => {
    const { fetchImpl, bodies } = fakeFetch(new Error('offline'), acknowledged())
    const options = { platform: 'macos', fetch: fetchImpl }

    await expect(requestAccountDeletion(ACCOUNT, { ...options, now: () => 1000 })).rejects.toMatchObject({
      reason: 'transport_failed',
    })
    const stored = await getAccountDeletionRequest(ACCOUNT.userId)
    expect(stored).toMatchObject({ requestedAt: 1000, acceptedAt: null })

    const retried = await requestAccountDeletion(ACCOUNT, { ...options, now: () => 2000 })

    expect(retried.requestId).toBe(stored?.requestId)
    expect(bodies[1].events[0]).toMatchObject({ insert_id: stored?.requestId, time: 1000 })
    expect(retried.acceptedAt).toBe(2000)
  })

  it('does not send a request that was already acknowledged', async () => {
    const { fetchImpl, calls } = fakeFetch(acknowledged())
    const first = await requestAccountDeletion(ACCOUNT, { platform: 'macos', fetch: fetchImpl })

    const second = await requestAccountDeletion(ACCOUNT, { platform: 'macos', fetch: fetchImpl })

    expect(second).toEqual(first)
    expect(calls).toHaveBeenCalledTimes(1)
  })

  it('shares one request id between concurrent requests', async () => {
    const { fetchImpl, bodies } = fakeFetch(acknowledged(), acknowledged())

    const [a, b] = await Promise.all([
      requestAccountDeletion(ACCOUNT, { platform: 'macos', fetch: fetchImpl }),
      requestAccountDeletion(ACCOUNT, { platform: 'macos', fetch: fetchImpl }),
    ])

    expect(a.requestId).toBe(b.requestId)
    expect(new Set(bodies.map((body) => body.events[0].insert_id)).size).toBe(1)
  })

  it.each([
    ['a non-200 status', new Response('{}', { status: 429 }), 'rejected'],
    ['a body that is not JSON', new Response('ok', { status: 200 }), 'invalid_response'],
    ['a body that acknowledges nothing', new Response(JSON.stringify({ code: 200, events_ingested: 0 }), { status: 200 }), 'unacknowledged'],
  ])('is not acknowledged by %s', async (_name, response, reason) => {
    const { fetchImpl } = fakeFetch(response)

    await expect(requestAccountDeletion(ACCOUNT, { platform: 'macos', fetch: fetchImpl })).rejects.toMatchObject({ reason })
    expect((await getAccountDeletionRequest(ACCOUNT.userId))?.acceptedAt).toBeNull()
  })

  it.each([
    ['an email', 'ada@example.com'],
    ['a URL', 'https://example.com/u/1'],
    ['an API key', 'sk-abc123'],
    ['nothing', ''],
  ])('refuses %s as an account id, before anything is stored or sent', async (_name, userId) => {
    const { fetchImpl, calls } = fakeFetch(acknowledged())

    await expect(requestAccountDeletion({ ...ACCOUNT, userId }, { platform: 'macos', fetch: fetchImpl })).rejects.toBeInstanceOf(
      AccountDeletionDeliveryError,
    )
    expect(calls).not.toHaveBeenCalled()
    expect(await getAccountDeletionRequest(userId)).toBeNull()
  })

  it('sends the account’s address without credentials, query or fragment', () => {
    expect(sanitizeWorkspaceUrl('https://user:pass@platform.example/base?token=1#frag')).toBe('https://platform.example/base')
    expect(() => sanitizeWorkspaceUrl('ftp://platform.example')).toThrow(AccountDeletionDeliveryError)
    expect(() => sanitizeWorkspaceUrl('not a url')).toThrow(AccountDeletionDeliveryError)
  })

  it('names the app that sent the request', () => {
    expect(deletionEventPlatform({ os: 'darwin', distribution: 'mac-app-store' })).toBe('macos')
    expect(deletionEventPlatform({ os: 'win32', distribution: 'direct' })).toBe('windows')
    expect(deletionEventPlatform({ os: 'linux', distribution: 'deployment' })).toBe('web')
  })
})
