import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { provisionEmail } from './setup'

const mocks = vi.hoisted(() => ({ orgScoped: true, member: true, fetch: vi.fn(), getAccessToken: vi.fn() }))
vi.mock('../platform-attribution', () => ({ attribution: {
  requiresActingMember: () => mocks.orgScoped,
  fromUserId: async () => mocks.orgScoped && mocks.member ? { bearerToken: () => 'org-runtime::member' } : null,
  current: async () => null,
} }))
vi.mock('../services/platform-auth-service', () => ({ getPlatformAccessToken: () => mocks.orgScoped ? 'org-runtime' : 'plat_sa_member' }))
vi.mock('../auth', () => ({ getAuth: () => ({ api: { getAccessToken: mocks.getAccessToken } }) }))

const input = { localPart: 'assistant', displayName: 'Assistant' }
const mailbox = { id: '00000000-0000-4000-8000-000000000001', address: 'assistant@company.ongamut.so', name: 'Assistant', status: 'active' }

beforeEach(() => {
  vi.resetAllMocks()
  mocks.orgScoped = true; mocks.member = true
  mocks.getAccessToken.mockRejectedValue(new Error('No saved member OAuth token'))
  vi.stubGlobal('fetch', mocks.fetch)
  mocks.fetch.mockImplementation(async (url: string) => {
    if (url.endsWith('/me')) return Response.json({ orgId: 'company', memberId: 'member' })
    if (url.endsWith('/mailboxes')) return Response.json(mailbox)
    throw new Error('Unexpected gateway request')
  })
})
afterEach(() => vi.unstubAllGlobals())

it.each([
  { mode: 'auth', orgScoped: true, owner: 'user', bearer: 'org-runtime::member' },
  { mode: 'non-auth local user', orgScoped: false, owner: 'local', bearer: 'plat_sa_member' },
  { mode: 'non-auth without a user row', orgScoped: false, owner: null, bearer: 'plat_sa_member' },
])('provisions with the normal credential and no OAuth account in $mode mode', async ({ orgScoped, owner, bearer }) => {
  mocks.orgScoped = orgScoped
  await expect(provisionEmail('agent', owner, input)).resolves.toMatchObject({
    address: mailbox.address, platformOrgId: 'company', platformMemberId: 'member',
  })
  expect(mocks.fetch).toHaveBeenCalledTimes(2)
  for (const [, init] of mocks.fetch.mock.calls) {
    expect(init.headers.get('Authorization')).toBe(`Bearer ${bearer}`)
    expect(init.headers.has('X-Platform-Discovery-Token')).toBe(false)
  }
  expect(mocks.getAccessToken).not.toHaveBeenCalled()
  expect(JSON.parse(mocks.fetch.mock.calls[1][1].body)).toEqual({ localPart: 'assistant', name: 'Assistant' })
})

it('rejects org runtimes without an acting member before provisioning', async () => {
  mocks.member = false
  await expect(provisionEmail('agent', 'user', input)).rejects.toMatchObject({ status: 403 })
  expect(mocks.fetch).not.toHaveBeenCalled()
})

it('preserves the mailbox reservation identity across retries', async () => {
  await provisionEmail('agent', 'user', input)
  await provisionEmail('agent', 'user', input)
  const key = mocks.fetch.mock.calls[1][1].headers.get('Idempotency-Key')
  expect(key).toHaveLength(64)
  expect(mocks.fetch.mock.calls[3][1].headers.get('Idempotency-Key')).toBe(key)
  await provisionEmail('another-agent', 'user', input)
  expect(mocks.fetch.mock.calls[5][1].headers.get('Idempotency-Key')).not.toBe(key)
})

it('preserves mailbox validation errors', async () => {
  mocks.fetch.mockResolvedValueOnce(Response.json({ orgId: 'company', memberId: 'member' }))
    .mockResolvedValueOnce(Response.json({ error: 'Inbox name is unavailable' }, { status: 422 }))
  await expect(provisionEmail('agent', 'user', input)).rejects.toMatchObject({ status: 422, message: 'Inbox name is unavailable' })
})
