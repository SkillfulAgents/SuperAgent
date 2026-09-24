import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { describeEmailSetup } from './setup-preview'

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), orgScoped: false, member: true, connected: true, getAccessToken: vi.fn() }))
vi.mock('../platform-attribution', () => ({ attribution: {
  requiresActingMember: () => mocks.orgScoped,
  current: async () => null,
  fromUserId: async () => mocks.orgScoped && mocks.member ? { bearerToken: () => 'org-runtime::member' } : null,
} }))
vi.mock('../services/platform-auth-service', () => ({ getPlatformAccessToken: () => !mocks.connected ? null : mocks.orgScoped ? 'org-runtime' : 'plat_sa_member' }))
vi.mock('../auth', () => ({ getAuth: () => ({ api: { getAccessToken: mocks.getAccessToken } }) }))

beforeEach(() => {
  vi.resetAllMocks()
  mocks.orgScoped = false; mocks.member = true; mocks.connected = true
  mocks.getAccessToken.mockResolvedValue({ accessToken: 'expired-oauth', accessTokenExpiresAt: new Date(0) })
  vi.stubGlobal('fetch', mocks.fetch)
  mocks.fetch.mockResolvedValue(Response.json({ emailDomain: 'company.ongamut.so' }))
})
afterEach(() => vi.unstubAllGlobals())

it.each([
  { mode: 'auth', orgScoped: true, owner: 'user', bearer: 'org-runtime::member' },
  { mode: 'non-auth local user', orgScoped: false, owner: 'local', bearer: 'plat_sa_member' },
  { mode: 'non-auth without a user row', orgScoped: false, owner: null, bearer: 'plat_sa_member' },
])('previews the domain with the normal Platform credential in $mode mode', async ({ orgScoped, owner, bearer }) => {
  mocks.orgScoped = orgScoped
  await expect(describeEmailSetup(owner)).resolves.toEqual({ emailDomain: 'company.ongamut.so' })
  expect(mocks.fetch).toHaveBeenCalledTimes(1)
  const [url, init] = mocks.fetch.mock.calls[0]
  expect(url).toBe('https://email-gateway.datawizz.workers.dev/v1/domain/setup')
  expect(init.method).toBeUndefined()
  expect(init.headers.get('Authorization')).toBe(`Bearer ${bearer}`)
  expect(init.headers.has('X-Platform-Discovery-Token')).toBe(false)
  expect(mocks.getAccessToken).not.toHaveBeenCalled()
})

it('rejects an org runtime without an acting member before making a request', async () => {
  mocks.orgScoped = true; mocks.member = false
  await expect(describeEmailSetup('user')).rejects.toMatchObject({ status: 403 })
  expect(mocks.fetch).not.toHaveBeenCalled()
})

it('requires a Platform connection in non-auth mode', async () => {
  mocks.connected = false
  await expect(describeEmailSetup(null)).rejects.toMatchObject({ status: 409 })
  expect(mocks.fetch).not.toHaveBeenCalled()
})

it('preserves gateway discovery errors without asking for unrelated OAuth sign-in', async () => {
  mocks.fetch.mockResolvedValue(Response.json({ error: 'Platform deployment discovery unavailable' }, { status: 503 }))
  await expect(describeEmailSetup(null)).rejects.toMatchObject({ status: 503, message: 'Platform deployment discovery unavailable' })
})

it('rejects a malformed preview instead of inventing an address', async () => {
  mocks.fetch.mockResolvedValue(Response.json({ domain: null }))
  await expect(describeEmailSetup(null)).rejects.toThrow()
})
