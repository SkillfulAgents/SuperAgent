import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { describeEmailSetup } from './setup-preview'

const mocks = vi.hoisted(() => ({ gatewayFetch: vi.fn(), memberFetch: vi.fn(), orgScoped: false, getAccessToken: vi.fn() }))
vi.mock('undici', () => ({ fetch: mocks.memberFetch }))
vi.mock('../platform-attribution', () => ({ attribution: { requiresActingMember: () => mocks.orgScoped, current: async () => null } }))
vi.mock('../services/platform-auth-service', () => ({ getPlatformAccessToken: () => 'access-key' }))
vi.mock('../platform-auth/config', () => ({ getPlatformProxyBaseUrl: () => 'https://proxy.example.com' }))
vi.mock('../auth', () => ({ getAuth: () => ({ api: { getAccessToken: mocks.getAccessToken } }) }))

afterEach(() => vi.unstubAllGlobals())

const deployment = { org_id: 'company', deployment_url: 'https://company.ongamut.so', status: 'deployed' }
beforeEach(() => {
  vi.clearAllMocks()
  mocks.orgScoped = false
  vi.stubGlobal('fetch', mocks.gatewayFetch)
  mocks.gatewayFetch.mockImplementation(async (url: string) => Response.json(url.endsWith('/domain') ? { domain: null } : { orgId: 'company' }))
  mocks.memberFetch.mockImplementation(async () => Response.json([deployment]))
})

it('uses the enrolled domain without deployment discovery', async () => {
  mocks.gatewayFetch.mockResolvedValue(Response.json({ domain: { name: 'existing.ongamut.so' } }))
  await expect(describeEmailSetup(null)).resolves.toEqual({ emailDomain: 'existing.ongamut.so' })
  expect(mocks.memberFetch).not.toHaveBeenCalled()
})
it('previews first enrollment using only reads, scoped to the connected organization', async () => {
  mocks.memberFetch.mockResolvedValue(Response.json([{ ...deployment, org_id: 'other', deployment_url: 'https://other.ongamut.so' }, deployment]))
  await expect(describeEmailSetup(null)).resolves.toEqual({ emailDomain: 'company.ongamut.so' })
  expect(mocks.memberFetch).toHaveBeenCalledWith('https://proxy.example.com/v1/me/deployments', expect.objectContaining({ headers: { Authorization: 'Bearer access-key' }, redirect: 'error' }))
  for (const [, init] of [...mocks.gatewayFetch.mock.calls, ...mocks.memberFetch.mock.calls]) expect(init?.method).toBeUndefined()
})
it('uses the refreshable member credential for org-scoped discovery', async () => {
  mocks.orgScoped = true
  const { attribution } = await import('../platform-attribution')
  Object.assign(attribution, { fromUserId: async () => ({ bearerToken: () => 'org::member' }) })
  mocks.getAccessToken.mockResolvedValue({ accessToken: 'member-oauth' })
  await expect(describeEmailSetup('user')).resolves.toEqual({ emailDomain: 'company.ongamut.so' })
  expect(mocks.memberFetch).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ headers: { Authorization: 'Bearer member-oauth' } }))
})
it.each([
  [],
  [deployment, deployment],
  [{ ...deployment, status: 'pending' }],
  [{ ...deployment, deployment_url: 'https://company.ongamut.so.evil.example' }],
  [{ ...deployment, deployment_url: 'http://company.ongamut.so' }],
].map(entries => ({ entries })))('does not invent an address for an unsupported or ambiguous deployment: $entries', async ({ entries }) => {
  mocks.memberFetch.mockResolvedValue(Response.json(entries))
  await expect(describeEmailSetup(null)).rejects.toThrow()
})
