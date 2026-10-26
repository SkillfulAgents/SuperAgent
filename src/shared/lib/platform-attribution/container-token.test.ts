import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppDatabase } from '@shared/lib/db/drivers/types'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import { platformAgentKeys } from '@shared/lib/db/schema'

let testDb: AppDatabase
vi.mock('@shared/lib/db', () => ({ get db() { return testDb } }))

const forAgent = vi.fn()
const requiresActingMember = vi.fn(() => false)
vi.mock('./index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./index')>()
  return {
    ...actual,
    attribution: { ...actual.attribution, forAgent: (slug: string) => forAgent(slug), requiresActingMember: () => requiresActingMember() },
  }
})
const platformAccessToken = vi.fn((): string | null => 'plat_sa_app')
const revokeRemotely = vi.fn(async (_token?: string) => true)
let realRevoke = false
vi.mock('../services/platform-auth-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/platform-auth-service')>()
  return {
    getPlatformAppKey: () => platformAccessToken() ?? process.env.PLATFORM_TOKEN ?? undefined,
    getStoredPlatformMemberId: () => null,
    revokePlatformTokenRemotely: (token: string | undefined) => realRevoke ? actual.revokePlatformTokenRemotely(token) : revokeRemotely(token),
  }
})
vi.mock('@shared/lib/platform-auth/config', () => ({ getPlatformProxyBaseUrl: () => 'https://proxy.example' }))
const agentExists = vi.fn(async (_slug: string) => true)
vi.mock('@shared/lib/agent-actor/agent-catalog', () => ({ agentCatalog: { exists: (slug: string) => agentExists(slug) } }))
const captureMessage = vi.fn()
vi.mock('../error-reporting', () => ({ captureMessage: (...args: unknown[]) => captureMessage(...args) }))

import { getPlatformContainerToken, revokePlatformAgentKey } from './container-token'
import { runWithAttribution, type Attribution } from './index'
import { _uninstallPlatformFetchInterceptorForTest, installPlatformFetchInterceptor } from './install-fetch-interceptor'

const fetchMock = vi.fn()
let handle: TestDatabase
const minted = (key: string) => new Response(JSON.stringify({ key }), { status: 201 })
const authorization = (call: number) => new Headers((fetchMock.mock.calls[call][1] as RequestInit).headers).get('Authorization')

beforeEach(async () => {
  handle = await createTestDatabase()
  testDb = handle.db
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  forAgent.mockReset().mockResolvedValue({ bearerToken: () => 'org-jwt::sub_owner' })
  requiresActingMember.mockReset().mockReturnValue(false)
  platformAccessToken.mockReset().mockReturnValue('plat_sa_app')
  revokeRemotely.mockReset().mockResolvedValue(true)
  agentExists.mockReset().mockResolvedValue(true)
  captureMessage.mockReset()
  realRevoke = false
})

afterEach(async () => {
  _uninstallPlatformFetchInterceptorForTest()
  vi.unstubAllGlobals()
  await handle.close()
})

describe('getPlatformContainerToken', () => {
  it("mints from the owner's app bearer once, then reuses the key", async () => {
    fetchMock.mockResolvedValueOnce(minted('plat_ag_one'))

    expect(await getPlatformContainerToken('agent-1')).toBe('plat_ag_one')
    expect(await getPlatformContainerToken('agent-1')).toBe('plat_ag_one')

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://proxy.example/v1/agent-keys')
    expect(authorization(0)).toBe('Bearer org-jwt::sub_owner')
    expect(JSON.parse(init.body as string)).toEqual({ agent_id: 'agent-1' })
  })

  it('keeps its own bearer when the fetch interceptor sees an ambient attribution', async () => {
    installPlatformFetchInterceptor()
    fetchMock.mockResolvedValueOnce(minted('plat_ag_one'))
    const ambient = { applyTo: (headers: Headers) => headers.set('Authorization', 'Bearer ambient') } as Attribution

    await runWithAttribution(ambient, () => getPlatformContainerToken('agent-1'))

    expect(authorization(0)).toBe('Bearer org-jwt::sub_owner')
  })

  it('mints a separate key when the app bearer changes', async () => {
    fetchMock.mockResolvedValueOnce(minted('plat_ag_owner')).mockResolvedValueOnce(minted('plat_ag_other'))

    expect(await getPlatformContainerToken('agent-1')).toBe('plat_ag_owner')
    forAgent.mockResolvedValue({ bearerToken: () => 'org-jwt::sub_other' })
    expect(await getPlatformContainerToken('agent-1')).toBe('plat_ag_other')
    forAgent.mockResolvedValue({ bearerToken: () => 'org-jwt::sub_owner' })
    expect(await getPlatformContainerToken('agent-1')).toBe('plat_ag_owner')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('shares one mint between concurrent callers', async () => {
    fetchMock.mockResolvedValueOnce(minted('plat_ag_one'))

    const keys = await Promise.all([getPlatformContainerToken('agent-1'), getPlatformContainerToken('agent-1')])

    expect(keys).toEqual(['plat_ag_one', 'plat_ag_one'])
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('gives the container no key when minting fails', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 503 }))

    expect(await getPlatformContainerToken('agent-1')).toBeUndefined()
    expect(captureMessage).toHaveBeenCalledWith('platform agent key mint failed', expect.anything())
  })

  it('gives the container no key without an app key or an agent', async () => {
    expect(await getPlatformContainerToken()).toBeUndefined()
    platformAccessToken.mockReturnValue(null)
    expect(await getPlatformContainerToken('agent-1')).toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(forAgent).not.toHaveBeenCalled()
  })

  it('gives the container no key when an org token resolves no member', async () => {
    forAgent.mockResolvedValue(null)
    requiresActingMember.mockReturnValue(true)

    expect(await getPlatformContainerToken('agent-1')).toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(captureMessage).toHaveBeenCalledWith(
      'platform container env built without acting member',
      expect.objectContaining({ tags: { area: 'platform-attribution', op: 'container.env.no_member' } }),
    )
  })

  it('mints nothing for an agent that no longer exists', async () => {
    agentExists.mockResolvedValue(false)

    expect(await getPlatformContainerToken('agent-1')).toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('mints from the PLATFORM_TOKEN env key when no account is connected', async () => {
    vi.stubEnv('PLATFORM_TOKEN', 'plat_sa_env')
    platformAccessToken.mockReturnValue(null)
    forAgent.mockResolvedValue(null)
    fetchMock.mockResolvedValueOnce(minted('plat_ag_one'))

    expect(await getPlatformContainerToken('agent-1')).toBe('plat_ag_one')
    expect(authorization(0)).toBe('Bearer plat_sa_env')
    vi.unstubAllEnvs()
  })

  it('mints from a member-bound access key that has no attribution', async () => {
    forAgent.mockResolvedValue(null)
    fetchMock.mockResolvedValueOnce(minted('plat_ag_one'))

    expect(await getPlatformContainerToken('agent-1')).toBe('plat_ag_one')
    expect(authorization(0)).toBe('Bearer plat_sa_app')
  })
})

describe('revokePlatformAgentKey', () => {
  it('waits for a key acquisition already under way, then revokes and forgets every key of the agent', async () => {
    await testDb.insert(platformAgentKeys).values([
      { agentSlug: 'agent-1', parentHash: 'a', key: 'plat_ag_a', createdAt: new Date() },
      { agentSlug: 'agent-2', parentHash: 'a', key: 'plat_ag_c', createdAt: new Date() },
    ])
    let finishMint: (res: Response) => void = () => {}
    fetchMock.mockReturnValueOnce(new Promise<Response>(resolve => { finishMint = resolve }))
    const pending = getPlatformContainerToken('agent-1')
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())

    const revoking = revokePlatformAgentKey('agent-1')
    finishMint(minted('plat_ag_b'))
    await Promise.all([pending, revoking])

    expect(revokeRemotely.mock.calls.map(([key]) => key).sort()).toEqual(['plat_ag_a', 'plat_ag_b'])
    expect(await testDb.select({ agentSlug: platformAgentKeys.agentSlug }).from(platformAgentKeys)).toEqual([{ agentSlug: 'agent-2' }])
  })

  it('sends only the agent key to /v1/revoke, whatever the ambient attribution', async () => {
    installPlatformFetchInterceptor()
    realRevoke = true
    await testDb.insert(platformAgentKeys).values({ agentSlug: 'agent-1', parentHash: 'a', key: 'plat_ag_a', createdAt: new Date() })
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }))
    const ambient = { applyTo: (headers: Headers) => headers.set('Authorization', 'Bearer plat_sa_app') } as Attribution

    await runWithAttribution(ambient, () => revokePlatformAgentKey('agent-1'))

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['https://proxy.example/v1/revoke'])
    expect(authorization(0)).toBe('Bearer plat_ag_a')
  })

  it('reports a failed revoke', async () => {
    await testDb.insert(platformAgentKeys).values({ agentSlug: 'agent-1', parentHash: 'a', key: 'plat_ag_a', createdAt: new Date() })
    revokeRemotely.mockResolvedValue(false)

    await revokePlatformAgentKey('agent-1')

    expect(captureMessage).toHaveBeenCalledWith('platform agent key revoke failed', expect.objectContaining({ extra: { agentId: 'agent-1', failed: 1 } }))
  })
})
