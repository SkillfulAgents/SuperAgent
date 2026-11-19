import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'

const mocks = vi.hoisted(() => ({
  getPlatformAuthStatusForUser: vi.fn(),
  getAccountDeletionRequest: vi.fn(),
  requestAccountDeletion: vi.fn(),
}))

vi.mock('../middleware/auth', () => ({
  Authenticated: () => async (_c: unknown, next: () => Promise<void>) => next(),
}))
vi.mock('@shared/lib/auth/config', () => ({ getCurrentUserId: () => 'local' }))
vi.mock('@shared/lib/analytics/tenant-id', () => ({ getTenantId: async () => 'tenant-1' }))
vi.mock('@shared/lib/facts/server-facts', () => ({
  getServerFacts: () => ({ os: 'darwin', distribution: 'mac-app-store' }),
}))
vi.mock('@shared/lib/platform-auth/config', () => ({ getPlatformBaseUrl: () => 'https://platform.example' }))
vi.mock('@shared/lib/services/platform-auth-service', () => ({
  getPlatformAuthStatusForUser: (...args: unknown[]) => mocks.getPlatformAuthStatusForUser(...args),
}))
vi.mock('@shared/lib/account-deletion/account-deletion-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@shared/lib/account-deletion/account-deletion-service')>()),
  getAccountDeletionRequest: (...args: unknown[]) => mocks.getAccountDeletionRequest(...args),
  requestAccountDeletion: (...args: unknown[]) => mocks.requestAccountDeletion(...args),
}))

import accountDeletion from './account-deletion'
import { AccountDeletionDeliveryError } from '@shared/lib/account-deletion/account-deletion-service'

const app = new Hono().route('/api/account-deletion', accountDeletion)

const RECORD = {
  requestId: '0b0e2c1a-1111-4222-8333-444455556666',
  requestedAt: 1000,
  userId: 'user-1',
  tenantId: 'tenant-1',
  workspaceUrl: 'https://platform.example/',
  acceptedAt: 2000,
}

function post(body: unknown) {
  return app.request('/api/account-deletion', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('account deletion routes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getPlatformAuthStatusForUser.mockResolvedValue({ connected: true, userId: 'user-1' })
    mocks.getAccountDeletionRequest.mockResolvedValue(null)
    mocks.requestAccountDeletion.mockResolvedValue(RECORD)
  })

  it.each([
    ['no account is connected', { connected: false, userId: null }],
    ['the connection names an organization and no person', { connected: true, userId: null }],
  ])('offers nothing when %s', async (_name, status) => {
    mocks.getPlatformAuthStatusForUser.mockResolvedValue(status)

    expect(await (await app.request('/api/account-deletion')).json()).toEqual({ available: false, request: null })
    expect((await post({ userId: 'user-1' })).status).toBe(409)
    expect(mocks.requestAccountDeletion).not.toHaveBeenCalled()
  })

  it('reports an earlier request without the ids it carries', async () => {
    mocks.getAccountDeletionRequest.mockResolvedValue({ ...RECORD, acceptedAt: null })

    const body = await (await app.request('/api/account-deletion')).json()

    expect(mocks.getAccountDeletionRequest).toHaveBeenCalledWith('user-1')
    expect(body).toEqual({
      available: true,
      request: { requestId: RECORD.requestId, requestedAt: 1000, accepted: false },
    })
  })

  it('requests deletion of the connected account, as the server knows it', async () => {
    const res = await post({ userId: 'user-1' })

    expect(res.status).toBe(200)
    expect(mocks.requestAccountDeletion).toHaveBeenCalledWith(
      { userId: 'user-1', workspaceUrl: 'https://platform.example', tenantId: 'tenant-1' },
      { platform: 'macos' },
    )
    expect(await res.json()).toEqual({
      available: true,
      request: { requestId: RECORD.requestId, requestedAt: 1000, accepted: true },
    })
  })

  it('refuses a request confirmed for an account that is no longer the connected one', async () => {
    const res = await post({ userId: 'someone-else' })

    expect(res.status).toBe(409)
    expect(mocks.requestAccountDeletion).not.toHaveBeenCalled()
  })

  it('refuses a request that names no account', async () => {
    expect((await post({})).status).toBe(400)
    expect(mocks.requestAccountDeletion).not.toHaveBeenCalled()
  })

  it('says so when delivery was not confirmed', async () => {
    mocks.requestAccountDeletion.mockRejectedValue(new AccountDeletionDeliveryError('unacknowledged'))

    const res = await post({ userId: 'user-1' })

    expect(res.status).toBe(502)
    expect(await res.json()).toMatchObject({ reason: 'unacknowledged', error: expect.stringContaining('same request ID') })
  })
})
