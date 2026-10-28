import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockResolveTarget = vi.fn()
vi.mock('./cloud-proxy-target', () => ({
  resolveCloudProxyTarget: () => mockResolveTarget(),
}))

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import {
  startCloudBootPrefetch,
  takeCloudBootPrefetch,
  _resetCloudBootPrefetchForTest,
  _heldCloudBootPrefetchCountForTest,
} from './cloud-boot-prefetch'

const TARGET = { deploymentUrl: 'https://workspace.example.com', token: 'deployment-token' }
const SESSION = '/api/auth/get-session'

function ok(body = '{"user":{"id":"u1"}}'): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
}

/** Read a claimed entry the way the proxy does. */
async function take(path: string, target = TARGET) {
  return await takeCloudBootPrefetch(path, target)
}

beforeEach(() => {
  vi.clearAllMocks()
  _resetCloudBootPrefetchForTest()
  mockResolveTarget.mockReturnValue(TARGET)
  mockFetch.mockImplementation(() => Promise.resolve(ok()))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('startCloudBootPrefetch', () => {
  it('asks the deployment for what a boot blocks on, on the app\'s authority', () => {
    startCloudBootPrefetch()

    const urls = mockFetch.mock.calls.map(([url]) => url as string)
    expect(urls).toContain(`${TARGET.deploymentUrl}${SESSION}`)
    expect(urls.every((url) => url.startsWith(TARGET.deploymentUrl))).toBe(true)

    const init = mockFetch.mock.calls[0][1] as RequestInit
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${TARGET.token}`)
    expect(init.method).toBe('GET')
  })

  it('does nothing when there is no workspace to prefetch from', () => {
    mockResolveTarget.mockReturnValue(null)
    startCloudBootPrefetch()
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('lets go of responses nobody ever claimed', async () => {
    // A boot that lands somewhere the prefetch did not predict — a login screen,
    // a workspace needing reconnection — claims none of these. Held on to, they
    // would keep a copy of the deployment's answers, fetched under a credential
    // that may since have been replaced, for the life of the process.
    vi.useFakeTimers()
    startCloudBootPrefetch()
    expect(_heldCloudBootPrefetchCountForTest()).toBeGreaterThan(0)

    await vi.advanceTimersByTimeAsync(60_000)

    expect(_heldCloudBootPrefetchCountForTest()).toBe(0)
  })

  it('bounds the flight it starts, so a claimed one cannot hang the request', () => {
    startCloudBootPrefetch()

    const init = mockFetch.mock.calls[0][1] as RequestInit
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('does not take the boot down when the workspace record cannot be read', () => {
    // One caller is app startup, ahead of the window existing.
    mockResolveTarget.mockImplementation(() => {
      throw new Error('settings unreadable')
    })

    expect(() => startCloudBootPrefetch()).not.toThrow()
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('drops entries from a previous run rather than letting them accumulate', async () => {
    startCloudBootPrefetch()
    mockResolveTarget.mockReturnValue(null)
    startCloudBootPrefetch()

    expect(await take(SESSION)).toBeNull()
  })
})

describe('takeCloudBootPrefetch', () => {
  it('hands the started request to the first caller that asks for it', async () => {
    startCloudBootPrefetch()

    const prefetched = await take(SESSION)

    expect(prefetched?.status).toBe(200)
    expect(new TextDecoder().decode(prefetched!.body)).toBe('{"user":{"id":"u1"}}')
  })

  it('answers only once, so a later refetch really refetches', async () => {
    startCloudBootPrefetch()

    expect(await take(SESSION)).not.toBeNull()
    expect(await take(SESSION)).toBeNull()
  })

  it('does not answer a path nobody prefetched', async () => {
    startCloudBootPrefetch()
    expect(await take('/api/sessions/abc')).toBeNull()
  })

  it('refuses an entry started under a token that has since been replaced', async () => {
    startCloudBootPrefetch()

    expect(await take(SESSION, { ...TARGET, token: 'refreshed-token' })).toBeNull()
  })

  it('refuses an entry started against a different deployment', async () => {
    startCloudBootPrefetch()

    expect(await take(SESSION, { ...TARGET, deploymentUrl: 'https://other.example.com' })).toBeNull()
  })

  it('expires, so a head start cannot outlive the switch that began it', async () => {
    vi.useFakeTimers()
    startCloudBootPrefetch()
    vi.advanceTimersByTime(60_000)

    expect(await take(SESSION)).toBeNull()
  })

  it('declines a non-200 so the caller makes the request itself', async () => {
    // A 401 needs the proxy's refresh-and-retry; replaying this copy would skip it.
    mockFetch.mockImplementation(() => Promise.resolve(new Response('nope', { status: 401 })))
    startCloudBootPrefetch()

    expect(await take(SESSION)).toBeNull()
  })

  it('declines when the deployment could not be reached', async () => {
    mockFetch.mockImplementation(() => Promise.reject(new Error('ECONNREFUSED')))
    startCloudBootPrefetch()

    expect(await take(SESSION)).toBeNull()
  })
})
