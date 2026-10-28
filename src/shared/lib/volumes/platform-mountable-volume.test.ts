import { afterEach, describe, expect, it, vi } from 'vitest'
import { s3Fixture } from './testing/s3-fixture'
import type { S3Location } from './s3-schema'

const mocks = vi.hoisted(() => ({ forAgent: vi.fn(), current: vi.fn(), capture: vi.fn() }))
vi.mock('@shared/lib/proxy/audit', () => ({ writeProxyAuditEntry: async () => {} }))
vi.mock('@shared/lib/platform-auth/config', () => ({ getPlatformProxyBaseUrl: () => 'https://proxy.test' }))
vi.mock('@shared/lib/platform-attribution', () => ({
  attribution: { forAgent: mocks.forAgent, current: async () => mocks.current() },
  runWithAttribution: (_auth: unknown, run: () => unknown) => run(),
}))
vi.mock('@shared/lib/error-reporting', async (importOriginal) => ({
  ...await importOriginal<typeof import('@shared/lib/error-reporting')>(),
  captureException: mocks.capture,
}))

import { PlatformMountableVolume, dropPlatformVolumeKeys, preparePlatformVolume } from './platform-mountable-volume'
import { platformVolumeConfigSchema, storedPlatformVolumeConfigSchema } from './volume-config-schema'

const ID = 'vol_00000000-0000-0000-0000-000000000001'
const member = (id: string) => ({ getKey: () => `member:${id}`, bearerToken: () => `org::${id}`, applyTo: (headers: Headers) => headers.set('Authorization', `Bearer org::${id}`) })
const minutes = (n: number, from = Date.now()) => new Date(from + n * 60_000).toISOString()
const later = (ms: number) => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + ms) }
const failure = (status: number, error?: Record<string, string>, headers: Record<string, string> = {}) =>
  error ? Response.json({ type: 'error', error }, { status, headers }) : new Response('upstream', { status, headers })

function setup({ expirations = [], date }: { expirations?: string[]; date?: () => string } = {}) {
  const f = s3Fixture(); f.put('a.md', new TextEncoder().encode('hi'))
  const { endpoint, region, bucket, prefix, forcePathStyle } = f.config
  // Mutable, so a test can move the drive.
  const platform: { location: S3Location } = { location: { endpoint, region, bucket, prefix, forcePathStyle } }
  const grant = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({
    location: platform.location,
    credentials: { accessKeyId: 'key', secretAccessKey: 'secret', sessionToken: 'session', expiration: expirations.shift() ?? minutes(15) },
  }, { headers: date ? { date: date() } : {} }))
  vi.stubGlobal('fetch', grant)
  const drive = (agent: string) => new PlatformMountableVolume('def', 'Docs', { volumeId: ID }, agent)
  return { f, grant, drive, platform }
}
afterEach(() => {
  dropPlatformVolumeKeys(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks()
  mocks.forAgent.mockReset(); mocks.current.mockReset(); mocks.capture.mockReset()
})

describe('Gamut drive keys', () => {
  it('reuses a drive key per member, never across members, and renews it in its last 5 minutes', async () => {
    mocks.forAgent.mockImplementation(async (slug: string) => member(slug === 'agent-b' ? 'm2' : 'm1'))
    const { grant, drive } = setup()
    await drive('agent-a').stat('a.md'); await drive('agent-a').stat('a.md')
    expect(grant).toHaveBeenCalledTimes(1)
    await drive('agent-b').stat('a.md')
    expect(grant).toHaveBeenCalledTimes(2)
    expect(grant.mock.calls[1][0]).toBe(`https://proxy.test/v1/volumes/${ID}/credentials`)
    expect(new Headers(grant.mock.calls[1][1]?.headers).get('Authorization')).toBe('Bearer org::m2')

    later(11 * 60_000)
    await drive('agent-a').stat('a.md'); await drive('agent-a').stat('a.md')
    expect(grant).toHaveBeenCalledTimes(3)
  })

  it('learns where the drive lives from its keys, so the platform can move it', async () => {
    mocks.forAgent.mockResolvedValue(member('m1'))
    const { f, drive, platform } = setup()
    f.putObject('moved/b.md', new TextEncoder().encode('moved'))
    await expect(drive('agent-a').stat('a.md')).resolves.toMatchObject({ kind: 'file' })
    platform.location = { ...platform.location, prefix: 'moved' }
    dropPlatformVolumeKeys()
    await expect(drive('agent-a').stat('b.md')).resolves.toMatchObject({ kind: 'file', size: 5 })
    await expect(drive('agent-a').stat('a.md')).rejects.toMatchObject({ code: 'not-found' })
  })

  it('refuses later keys for another place while a volume is open', async () => {
    mocks.forAgent.mockResolvedValue(member('m1'))
    const { grant, drive, platform } = setup()
    const volume = drive('agent-a')
    await volume.stat('a.md')
    later(11 * 60_000)
    platform.location = { ...platform.location, prefix: 'moved' }
    await expect(volume.stat('a.md')).rejects.toMatchObject({ code: 'not-accessible', message: 'This Gamut drive moved. Please try again.' })
    expect(grant).toHaveBeenCalledTimes(2)
  })

  it('shares one key request between simultaneous first uses', async () => {
    mocks.forAgent.mockResolvedValue(member('m1'))
    const { grant, drive } = setup()
    await Promise.all([drive('agent-a').stat('a.md'), drive('agent-a').stat('a.md'), drive('agent-a').list('')])
    expect(grant).toHaveBeenCalledTimes(1)
  })

  it('shares one refresh between callers waiting on the same expiring key', async () => {
    mocks.forAgent.mockResolvedValue(member('m1'))
    const { grant, drive } = setup()
    await drive('agent-a').stat('a.md')
    later(11 * 60_000)
    await Promise.all([drive('agent-a').stat('a.md'), drive('agent-a').stat('a.md')])
    expect(grant).toHaveBeenCalledTimes(2)
  })

  it('fails every waiter on a failed key fetch, then fetches again', async () => {
    mocks.forAgent.mockResolvedValue(member('m1'))
    const { grant, drive } = setup()
    grant.mockResolvedValueOnce(failure(502, { type: 'api_error', message: 'Gamut drives are unavailable' }))
    await expect(drive('agent-a').stat('a.md')).rejects.toMatchObject({ status: 503 })
    await expect(drive('agent-a').stat('a.md')).resolves.toMatchObject({ kind: 'file' })
    grant.mockResolvedValueOnce(failure(403, { type: 'file_error', message: 'no', code: 'not-accessible' }))
    dropPlatformVolumeKeys()
    await expect(drive('agent-a').stat('a.md')).rejects.toMatchObject({ code: 'not-accessible' })
  })

  it('reads key expiry by the platform clock, and signs in its time', async () => {
    mocks.forAgent.mockResolvedValue(member('m1'))
    // This machine runs 11 minutes fast: 15-minute keys look as if they had 4 left.
    const platformNow = () => Date.now() - 11 * 60_000
    const { f, grant, drive } = setup({ expirations: [minutes(15, platformNow())], date: () => new Date(platformNow()).toUTCString() })
    await drive('agent-a').stat('a.md')
    later(5 * 60_000)
    await drive('agent-a').stat('a.md')
    expect(grant).toHaveBeenCalledTimes(1)
    const signed = f.requests.at(-1)!.headers['x-amz-date'].replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z')
    expect(Math.abs(Date.parse(signed) - platformNow())).toBeLessThan(5_000)
  })

  it('reuses short-lived keys for half their life when the platform sends no time', async () => {
    mocks.forAgent.mockResolvedValue(member('m1'))
    const { grant, drive } = setup({ expirations: [minutes(4)] })
    await drive('agent-a').stat('a.md'); await drive('agent-a').stat('a.md')
    expect(grant).toHaveBeenCalledTimes(1)
    later(2 * 60_000 + 1_000)
    await drive('agent-a').stat('a.md')
    expect(grant).toHaveBeenCalledTimes(2)
  })

  it('names the acting member once per request, and keeps it briefly across requests', async () => {
    mocks.forAgent.mockResolvedValue(member('m1'))
    const { drive } = setup()
    const volume = drive('agent-a')
    await volume.stat('a.md'); await volume.list(''); await volume.read('a.md'); await drive('agent-a').stat('a.md')
    expect(mocks.forAgent).toHaveBeenCalledTimes(1)
    later(31_000)
    await drive('agent-a').stat('a.md')
    expect(mocks.forAgent).toHaveBeenCalledTimes(2)
    dropPlatformVolumeKeys()
    await drive('agent-a').stat('a.md')
    expect(mocks.forAgent).toHaveBeenCalledTimes(3)
  })

  it('passes a key failure inside an S3 call through, without retrying it or cooling the bucket down', async () => {
    mocks.forAgent.mockImplementation(async (slug: string) => member(slug === 'agent-b' ? 'm2' : 'm1'))
    const { grant, drive } = setup()
    const volume = drive('agent-a')
    await volume.stat('a.md')
    later(11 * 60_000)
    grant.mockResolvedValueOnce(failure(429, { type: 'rate_limit_error', message: 'Slow down' }, { 'retry-after': '30' }))
    await expect(volume.stat('a.md')).rejects.toMatchObject({ status: 429, retryAfter: 30, message: 'Slow down' })
    expect(grant).toHaveBeenCalledTimes(2)
    // A cooldown of 30 seconds on the bucket would refuse this at once.
    await expect(drive('agent-b').stat('a.md')).resolves.toMatchObject({ kind: 'file' })
  })

  it('publishes a change only while a member still holds keys', async () => {
    mocks.forAgent.mockResolvedValue(member('m1'))
    const { f, drive } = setup()
    await drive('agent-a').stat('a.md')
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const writing = drive('agent-a').write('new.md', new ReadableStream({ start(c) { controller = c } })).catch(error => error)
    await vi.waitFor(() => expect(f.requests.some(request => request.method === 'HEAD' && request.key.endsWith('new.md'))).toBe(true))
    mocks.forAgent.mockResolvedValue(null)
    dropPlatformVolumeKeys()
    controller.enqueue(new TextEncoder().encode('x')); controller.close()
    expect(await writing).toMatchObject({ code: 'not-accessible' })
    expect(f.exists('new.md')).toBe(false)
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

  it('refuses a write or delete from a caller with no member before touching S3', async () => {
    mocks.forAgent.mockResolvedValue(null)
    const { f, drive } = setup()
    await expect(drive('agent-c').write('new.md', new Blob(['x']).stream())).rejects.toMatchObject({ code: 'not-accessible' })
    await expect(drive('agent-c').delete('a.md')).rejects.toMatchObject({ code: 'not-accessible' })
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

describe('Gamut drive platform answers', () => {
  it.each([
    ['a refusal, with its reason', failure(403, { type: 'file_error', message: 'Gamut drive is not accessible', code: 'not-accessible' }), { code: 'not-accessible', message: 'Gamut drive is not accessible' }],
    ['a rate limit, with its Retry-After', failure(429, { type: 'rate_limit_error', message: 'Too many requests' }, { 'retry-after': '12' }), { status: 429, retryAfter: 12, message: 'Too many requests' }],
    ['a rate limit with no body', failure(429), { status: 429, message: 'Gamut drives are busy. Please try again shortly.' }],
    ['a rejected sign-in', failure(401, { type: 'authentication_error', message: 'Sign in again' }), { status: 403, message: 'Sign in again' }],
    ['an unconfigured platform', failure(503, { type: 'api_error', message: 'Gamut drives are not configured' }), { status: 503, message: 'Gamut drives are not configured' }],
  ])('keeps %s', async (_label, response, expected) => {
    mocks.forAgent.mockResolvedValue(member('m1'))
    const { grant, drive } = setup()
    grant.mockResolvedValueOnce(response)
    await expect(drive('agent-a').stat('a.md')).rejects.toMatchObject(expected)
  })

  it('reports answers it cannot use to Sentry once a minute per kind, without keys', async () => {
    later(60 * 60_000)
    mocks.forAgent.mockResolvedValue(member('m1'))
    const { grant, drive } = setup()
    const unavailable = { status: 503, message: 'Gamut drives are unavailable. Please try again.' }

    grant.mockResolvedValueOnce(failure(502, { type: 'api_error', message: 'Gamut drives are unavailable' }, { 'cf-ray': 'ray-1' }))
    await expect(drive('agent-a').stat('a.md')).rejects.toMatchObject(unavailable)
    expect(mocks.capture).toHaveBeenCalledTimes(1)
    expect(mocks.capture.mock.calls[0][1]).toMatchObject({
      tags: { area: 'gamut-drives', op: 'credentials', failure: 'status', status: '502' },
      extra: { method: 'POST', route: `/v1/volumes/${ID}/credentials`, status: 502, ray: 'ray-1', platformError: { message: 'Gamut drives are unavailable' } },
    })
    grant.mockResolvedValueOnce(failure(502))
    await expect(drive('agent-a').stat('a.md')).rejects.toMatchObject(unavailable)
    expect(mocks.capture).toHaveBeenCalledTimes(1)

    grant.mockResolvedValueOnce(Response.json({ location: {}, credentials: { accessKeyId: 'key', secretAccessKey: 'SECRET' } }))
    await expect(drive('agent-a').stat('a.md')).rejects.toMatchObject(unavailable)
    grant.mockRejectedValueOnce(new TypeError('fetch failed'))
    await expect(drive('agent-a').stat('a.md')).rejects.toMatchObject(unavailable)
    expect(mocks.capture.mock.calls.map(([, context]) => context.tags.failure)).toEqual(['status', 'shape', 'network'])
    expect(mocks.capture.mock.calls[1][1].extra.issues).toContain('credentials.sessionToken: invalid_type')
    expect(JSON.stringify(mocks.capture.mock.calls)).not.toMatch(/SECRET|org::m1/)

    later(61_000)
    grant.mockResolvedValueOnce(failure(502))
    await expect(drive('agent-a').stat('a.md')).rejects.toMatchObject(unavailable)
    expect(mocks.capture).toHaveBeenCalledTimes(4)
    expect(mocks.capture.mock.calls[3][1].extra).toMatchObject({ suppressedSinceLastReport: 1 })
  })
})

describe('saving a Gamut drive', () => {
  const created = 'vol_00000000-0000-0000-0000-000000000002'

  it('creates a drive from a name with one call and saves only its id', async () => {
    mocks.current.mockResolvedValue(member('m1'))
    const platform = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ id: created, name: 'Q4 Plans', createdAt: '2026-10-15T00:00:00Z' }, { status: 201 }))
    vi.stubGlobal('fetch', platform)
    expect(await preparePlatformVolume({ name: 'Q4 Plans' })).toEqual({ name: 'Q4 Plans', config: { volumeId: created } })
    expect(platform.mock.calls.map(([url, init]) => [url, init?.method, init?.body])).toEqual([
      ['https://proxy.test/v1/volumes', 'POST', JSON.stringify({ name: 'Q4 Plans' })],
    ])
  })

  it('saves an existing drive with one list call and one member lookup', async () => {
    mocks.current.mockResolvedValue(member('m1'))
    const platform = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ volumes: [{ id: ID, name: 'Docs', createdAt: '2026-10-15T00:00:00Z' }] }))
    vi.stubGlobal('fetch', platform)
    expect(await preparePlatformVolume({ volumeId: ID })).toEqual({ name: 'Docs', config: { volumeId: ID } })
    await expect(preparePlatformVolume({ volumeId: created })).rejects.toMatchObject({ status: 404 })
    expect(platform).toHaveBeenCalledTimes(2)
    expect(mocks.current).toHaveBeenCalledTimes(1)
  })

  it('checks a new drive’s name before the platform creates it', () => {
    for (const name of ['', '..', 'a/b', 'a\\b']) expect(platformVolumeConfigSchema.safeParse({ name }).success).toBe(false)
    expect(platformVolumeConfigSchema.parse({ name: ' Launch ' })).toEqual({ name: 'Launch' })
  })

  it('reads a definition saved with its location, and uses the location of its keys', () => {
    const saved = { volumeId: ID, endpoint: '', region: 'us-east-2', bucket: 'gamut', prefix: `org-1/volumes/${ID}`, forcePathStyle: false }
    expect(storedPlatformVolumeConfigSchema.parse(saved)).toEqual({ volumeId: ID })
  })
})
