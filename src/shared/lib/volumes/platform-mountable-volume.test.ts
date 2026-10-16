import { afterEach, describe, expect, it, vi } from 'vitest'
import { s3Fixture } from './testing/s3-fixture'

const mocks = vi.hoisted(() => ({ forAgent: vi.fn(), current: vi.fn() }))
vi.mock('@shared/lib/proxy/audit', () => ({ writeProxyAuditEntry: async () => {} }))
vi.mock('@shared/lib/platform-auth/config', () => ({ getPlatformProxyBaseUrl: () => 'https://proxy.test' }))
vi.mock('@shared/lib/platform-attribution', () => ({
  attribution: { forAgent: mocks.forAgent, current: async () => mocks.current() },
  runWithAttribution: (_auth: unknown, run: () => unknown) => run(),
}))

import { PlatformMountableVolume, dropPlatformVolumeKeys, preparePlatformVolume } from './platform-mountable-volume'

const member = (id: string) => ({ getKey: () => `member:${id}`, bearerToken: () => `org::${id}`, applyTo: (headers: Headers) => headers.set('Authorization', `Bearer org::${id}`) })
const minutes = (n: number) => new Date(Date.now() + n * 60_000).toISOString()

function setup(expirations: string[] = [], granted?: { prefix: string }) {
  const f = s3Fixture(); f.put('a.md', new TextEncoder().encode('hi'))
  const { endpoint, region, bucket, prefix, forcePathStyle } = f.config
  const location = { endpoint, region, bucket, prefix, forcePathStyle }
  const grant = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({
    location: { ...location, ...granted },
    credentials: { accessKeyId: 'key', secretAccessKey: 'secret', sessionToken: 'session', expiration: expirations.shift() ?? minutes(15) },
  })))
  vi.stubGlobal('fetch', grant)
  const drive = (agent: string) => new PlatformMountableVolume('def', 'Docs', { ...location, volumeId: 'vol_00000000-0000-0000-0000-000000000001' }, agent)
  return { f, grant, drive }
}
afterEach(() => { dropPlatformVolumeKeys(); vi.unstubAllGlobals(); vi.restoreAllMocks(); mocks.forAgent.mockReset() })

describe('Gamut drive keys', () => {
  it('reuses a drive key per member, never across members, and renews it in its last 5 minutes', async () => {
    mocks.forAgent.mockImplementation(async (slug: string) => member(slug === 'agent-b' ? 'm2' : 'm1'))
    const { grant, drive } = setup()
    await drive('agent-a').stat('a.md'); await drive('agent-a').stat('a.md')
    expect(grant).toHaveBeenCalledTimes(1)
    await drive('agent-b').stat('a.md')
    expect(grant).toHaveBeenCalledTimes(2)
    expect(grant.mock.calls[1][0]).toBe('https://proxy.test/v1/volumes/vol_00000000-0000-0000-0000-000000000001/credentials')
    expect(new Headers(grant.mock.calls[1][1]?.headers).get('Authorization')).toBe('Bearer org::m2')

    dropPlatformVolumeKeys()
    const renewing = setup([minutes(4)])
    await renewing.drive('agent-a').stat('a.md'); await renewing.drive('agent-a').stat('a.md')
    expect(renewing.grant).toHaveBeenCalledTimes(2)
  })

  it('refuses keys issued for another location', async () => {
    mocks.forAgent.mockResolvedValue(member('m1'))
    const { f, drive } = setup([], { prefix: 'org-other/volumes/x' })
    await expect(drive('agent-a').stat('a.md')).rejects.toMatchObject({ code: 'not-accessible' })
    expect(f.requests).toHaveLength(0)
  })

  it('shares one key request between simultaneous first uses', async () => {
    mocks.forAgent.mockResolvedValue(member('m1'))
    const { grant, drive } = setup()
    await Promise.all([drive('agent-a').stat('a.md'), drive('agent-a').stat('a.md'), drive('agent-a').list('')])
    expect(grant).toHaveBeenCalledTimes(1)
  })

  it('shares one refresh between callers waiting on the same expiring key', async () => {
    mocks.forAgent.mockResolvedValue(member('m1'))
    const { grant, drive } = setup([minutes(6)])
    await drive('agent-a').stat('a.md')
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 2 * 60_000)
    await Promise.all([drive('agent-a').stat('a.md'), drive('agent-a').stat('a.md')])
    expect(grant).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it('fails every waiter on a failed key fetch, then fetches again', async () => {
    mocks.forAgent.mockResolvedValue(member('m1'))
    const { grant, drive } = setup()
    grant.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'down' } }), { status: 502 }))
    await expect(drive('agent-a').stat('a.md')).rejects.toMatchObject({ status: 503 })
    await expect(drive('agent-a').stat('a.md')).resolves.toMatchObject({ kind: 'file' })
    grant.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'no', code: 'not-accessible' } }), { status: 403 }))
    dropPlatformVolumeKeys()
    await expect(drive('agent-a').stat('a.md')).rejects.toMatchObject({ code: 'not-accessible' })
  })

  it('answers no cached lookup to a caller with no member', async () => {
    mocks.forAgent.mockImplementation(async (slug: string) => slug === 'agent-a' ? member('m1') : null)
    const { f, drive } = setup()
    f.mkdir('dir')
    await drive('agent-a').list('')
    const before = f.requests.length
    for (const path of ['dir', 'missing']) await expect(drive('agent-c').stat(path)).rejects.toMatchObject({ code: 'not-accessible' })
    expect(f.requests.length).toBe(before)
  })

  it('refuses a write from a caller with no member before touching S3', async () => {
    mocks.forAgent.mockResolvedValue(null)
    const { f, drive } = setup()
    await expect(drive('agent-c').write('new.md', new Blob(['x']).stream())).rejects.toMatchObject({ code: 'not-accessible' })
    expect(f.requests).toHaveLength(0)
  })

  it('refuses a cached listing to a caller with no member', async () => {
    mocks.forAgent.mockImplementation(async (slug: string) => slug === 'agent-a' ? member('m1') : null)
    const { drive } = setup()
    await drive('agent-a').list('')
    await expect(drive('agent-c').list('')).rejects.toMatchObject({ code: 'not-accessible' })
  })

  it('is not accessible when no member can be named', async () => {
    mocks.forAgent.mockResolvedValue(null)
    const { grant, drive } = setup()
    await expect(drive('agent-a').stat('a.md')).rejects.toMatchObject({ code: 'not-accessible' })
    expect(grant).not.toHaveBeenCalled()
  })
})

describe('saving a Gamut drive', () => {
  it('creates a drive from a name and saves the location its first keys name', async () => {
    mocks.current.mockResolvedValue(member('m1'))
    const id = 'vol_00000000-0000-0000-0000-000000000002'
    const location = { endpoint: '', region: 'us-east-2', bucket: 'gamut-staging', prefix: `org-1/volumes/${id}`, forcePathStyle: false }
    const platform = vi.fn(async (url: string, _init?: RequestInit) => new Response(JSON.stringify(url.endsWith('/credentials')
      ? { location, credentials: { accessKeyId: 'key', secretAccessKey: 'secret', sessionToken: 'session', expiration: minutes(15) } }
      : { id, name: 'Q4 Plans', createdAt: '2026-10-15T00:00:00Z' })))
    vi.stubGlobal('fetch', platform)
    expect(await preparePlatformVolume({ name: 'Q4 Plans' })).toEqual({ name: 'Q4 Plans', config: { ...location, volumeId: id } })
    expect(platform.mock.calls.map(([url, init]) => [url, init?.method, init?.body])).toEqual([
      ['https://proxy.test/v1/volumes', 'POST', JSON.stringify({ name: 'Q4 Plans' })],
      [`https://proxy.test/v1/volumes/${id}/credentials`, 'POST', undefined],
    ])
  })
})
