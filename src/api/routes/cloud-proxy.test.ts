import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
let remoteAddress: string | undefined = '127.0.0.1'

vi.mock('@hono/node-server/conninfo', () => ({
  getConnInfo: () => ({ remote: { address: remoteAddress } }),
}))

const mockIsAuthMode = vi.fn(() => false)
vi.mock('@shared/lib/auth/mode', () => ({
  isAuthMode: () => mockIsAuthMode(),
}))

const mockResolveTarget = vi.fn()
const mockRefreshTarget = vi.fn()
vi.mock('@shared/lib/services/cloud-proxy-target', () => ({
  resolveCloudProxyTarget: () => mockResolveTarget(),
  refreshCloudProxyTarget: () => mockRefreshTarget(),
}))

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import cloudProxy, { CLOUD_PROXY_PREFIX, isCloudProxyEnabled } from './cloud-proxy'
import {
  SKIP_BOOT_PREFETCH_HEADER,
  startCloudBootPrefetch,
  _resetCloudBootPrefetchForTest,
} from '@shared/lib/services/cloud-boot-prefetch'
import { getCloudProxyKey } from '@shared/lib/services/cloud-proxy-key'

const app = new Hono()
app.route(CLOUD_PROXY_PREFIX, cloudProxy)

const TARGET = { deploymentUrl: 'https://workspace.example.com', token: 'deployment-token' }

/** Call the proxy the way the renderer does: through the keyed prefix. */
async function call(pathAndQuery: string, init?: RequestInit): Promise<Response> {
  return app.request(
    `http://127.0.0.1:3000${CLOUD_PROXY_PREFIX}/${getCloudProxyKey()}${pathAndQuery}`,
    init,
  )
}

/** The URL the last forwarded request targeted. */
function forwardedUrl(callIndex = 0): string {
  return mockFetch.mock.calls[callIndex][0] as string
}

function forwardedInit(callIndex = 0): RequestInit & { headers: Headers } {
  return mockFetch.mock.calls[callIndex][1] as RequestInit & { headers: Headers }
}

beforeEach(() => {
  vi.clearAllMocks()
  remoteAddress = '127.0.0.1'
  mockIsAuthMode.mockReturnValue(false)
  mockResolveTarget.mockReturnValue(TARGET)
  mockRefreshTarget.mockResolvedValue(null)
  // Reset, not just clear: clearAllMocks leaves the mockResolvedValueOnce queue
  // intact, so one test that stops short of its retry would hand its leftover
  // response to the next one and misattribute the failure.
  mockFetch.mockReset()
  // An implementation, not a resolved value: a Response body can only be read
  // once, so a shared instance would break any test whose request is retried.
  mockFetch.mockImplementation(async () => new Response('{}', { status: 200 }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.stubGlobal('fetch', mockFetch)
})

describe('cloud proxy mounting', () => {
  const originalType = process.type

  afterEach(() => {
    ;(process as { type?: string }).type = originalType
  })

  it('runs in the Electron main process of a local install', () => {
    ;(process as { type?: string }).type = 'browser'
    mockIsAuthMode.mockReturnValue(false)
    expect(isCloudProxyEnabled()).toBe(true)
  })

  it('never runs inside an auth-mode deployment', () => {
    ;(process as { type?: string }).type = 'browser'
    mockIsAuthMode.mockReturnValue(true)
    expect(isCloudProxyEnabled()).toBe(false)
  })

  it('does not run outside Electron main', () => {
    ;(process as { type?: string }).type = undefined
    mockIsAuthMode.mockReturnValue(false)
    expect(isCloudProxyEnabled()).toBe(false)
  })
})

describe('cloud proxy access control', () => {
  it('rejects a caller that is not on the loopback interface', async () => {
    remoteAddress = '192.168.1.50'
    const res = await call('/api/agents')
    expect(res.status).toBe(403)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('rejects a request carrying a real website Origin', async () => {
    const res = await call('/api/agents', { headers: { origin: 'https://evil.example' } })
    expect(res.status).toBe(403)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('accepts the packaged renderer, whose Origin is the string "null"', async () => {
    const res = await call('/api/agents', { headers: { origin: 'null' } })
    expect(res.status).toBe(200)
  })

  it('accepts the dev renderer served from a loopback origin', async () => {
    const res = await call('/api/agents', { headers: { origin: 'http://localhost:5173' } })
    expect(res.status).toBe(200)
  })

  it('answers 404 — not 403 — for a wrong key, so probing learns nothing', async () => {
    const res = await app.request(
      `http://127.0.0.1:3000${CLOUD_PROXY_PREFIX}/not-the-key/api/agents`,
    )
    expect(res.status).toBe(404)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('answers 404 for a key of the right length but wrong value', async () => {
    const wrong = 'x'.repeat(getCloudProxyKey().length)
    const res = await app.request(`http://127.0.0.1:3000${CLOUD_PROXY_PREFIX}/${wrong}/api/agents`)
    expect(res.status).toBe(404)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('forwards only /api paths', async () => {
    const res = await call('/settings.json')
    expect(res.status).toBe(404)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('does not treat a path merely starting with the letters "api" as an API path', async () => {
    const res = await call('/apikeys')
    expect(res.status).toBe(404)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('reports 503 when no workspace token is held', async () => {
    mockResolveTarget.mockReturnValue(null)
    const res = await call('/api/agents')
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: 'cloud_workspace_unavailable' })
    expect(mockFetch).not.toHaveBeenCalled()
  })
})

describe('cloud proxy forwarding', () => {
  it('forwards method, path and query to the deployment', async () => {
    await call('/api/agents/my-agent/sessions?limit=20', { method: 'DELETE' })
    expect(forwardedUrl()).toBe(
      'https://workspace.example.com/api/agents/my-agent/sessions?limit=20',
    )
    expect(forwardedInit().method).toBe('DELETE')
  })

  it('preserves the caller’s percent-encoding rather than re-encoding the path', async () => {
    await call('/api/agents/a%2Fb/files')
    expect(forwardedUrl()).toBe('https://workspace.example.com/api/agents/a%2Fb/files')
  })

  it('attaches the deployment bearer', async () => {
    await call('/api/agents')
    expect(forwardedInit().headers.get('authorization')).toBe('Bearer deployment-token')
  })

  it('never forwards a caller-supplied Authorization header', async () => {
    await call('/api/agents', { headers: { authorization: 'Bearer attacker-token' } })
    expect(forwardedInit().headers.get('authorization')).toBe('Bearer deployment-token')
  })

  it('forwards the headers a stream resume and a range request depend on', async () => {
    await call('/api/agents/x/files/clip.mp4', {
      headers: { 'last-event-id': '42', range: 'bytes=0-1023', accept: 'video/mp4' },
    })
    const headers = forwardedInit().headers
    expect(headers.get('last-event-id')).toBe('42')
    expect(headers.get('range')).toBe('bytes=0-1023')
    expect(headers.get('accept')).toBe('video/mp4')
  })

  it('drops headers outside the allowlist', async () => {
    await call('/api/agents', {
      headers: { cookie: 'local=1', 'x-superagent-internal': 'yes', referer: 'http://localhost' },
    })
    const headers = forwardedInit().headers
    expect(headers.get('cookie')).toBeNull()
    expect(headers.get('x-superagent-internal')).toBeNull()
    expect(headers.get('referer')).toBeNull()
  })

  it('resolves redirects upstream instead of handing them to the renderer', async () => {
    await call('/api/agents')
    expect(forwardedInit().redirect).toBe('follow')
  })

  it('streams a response body through instead of buffering it', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c
      },
    })
    mockFetch.mockResolvedValue(
      new Response(stream, { headers: { 'content-type': 'text/event-stream' } }),
    )

    const res = await call('/api/agents/x/sessions/1/stream')
    expect(res.headers.get('content-type')).toBe('text/event-stream')

    // The response resolved while the upstream stream is still open — a
    // buffering proxy could not have got here.
    const reader = res.body!.getReader()
    controller.enqueue(new TextEncoder().encode('data: first\n\n'))
    const { value } = await reader.read()
    expect(new TextDecoder().decode(value)).toBe('data: first\n\n')
    controller.close()
  })

  it('strips deployment credentials from the response', async () => {
    mockFetch.mockResolvedValue(
      new Response('{}', {
        headers: {
          'set-cookie': 'session=abc; HttpOnly',
          'set-auth-token': 'token-value',
          'content-type': 'application/json',
        },
      }),
    )
    const res = await call('/api/agents')
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(res.headers.get('set-auth-token')).toBeNull()
    expect(res.headers.get('content-type')).toBe('application/json')
  })

  it('strips upstream CORS headers so the local ones are not duplicated', async () => {
    mockFetch.mockResolvedValue(
      new Response('{}', {
        headers: {
          'access-control-allow-origin': 'https://workspace.example.com',
          'access-control-allow-credentials': 'true',
        },
      }),
    )
    const res = await call('/api/agents')
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
    expect(res.headers.get('access-control-allow-credentials')).toBeNull()
  })

  it('strips framing headers that no longer describe the body it re-sends', async () => {
    mockFetch.mockResolvedValue(
      new Response('{}', { headers: { 'content-encoding': 'gzip', 'content-length': '999' } }),
    )
    const res = await call('/api/agents')
    expect(res.headers.get('content-encoding')).toBeNull()
    expect(res.headers.get('content-length')).toBeNull()
  })

  it('passes the upstream status through', async () => {
    mockFetch.mockResolvedValue(new Response('nope', { status: 403 }))
    const res = await call('/api/agents')
    expect(res.status).toBe(403)
    expect(await res.text()).toBe('nope')
  })

  it('reports an unreachable deployment as 502', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'))
    const res = await call('/api/agents')
    expect(res.status).toBe(502)
    expect(await res.json()).toMatchObject({ error: 'cloud_workspace_unreachable' })
  })
})

describe('cloud proxy token refresh', () => {
  const json = (body: string) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': String(body.length) },
    body,
  })

  it('re-mints and replays the request once on a 401', async () => {
    mockFetch
      .mockResolvedValueOnce(new Response('expired', { status: 401 }))
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }))
    mockRefreshTarget.mockResolvedValue({ ...TARGET, token: 'fresh-token' })

    const res = await call('/api/agents', json('{"name":"a"}'))

    expect(res.status).toBe(200)
    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(forwardedInit(1).headers.get('authorization')).toBe('Bearer fresh-token')
    expect(await res.text()).toBe('{"ok":true}')
  })

  it('replays the same body, not an empty one', async () => {
    mockFetch
      .mockResolvedValueOnce(new Response('expired', { status: 401 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
    mockRefreshTarget.mockResolvedValue({ ...TARGET, token: 'fresh-token' })

    await call('/api/agents', json('{"name":"a"}'))

    const replayed = forwardedInit(1).body as ArrayBuffer
    expect(new TextDecoder().decode(replayed)).toBe('{"name":"a"}')
  })

  it.each([
    ['POST', '/api/agents/x/interrupt'],
    ['DELETE', '/api/agents/x'],
    ['PATCH', '/api/notifications/1'],
    ['PUT', '/api/user-settings'],
  ])('retries a bodyless %s, which sends no content-length', async (method, path) => {
    mockFetch
      .mockResolvedValueOnce(new Response('expired', { status: 401 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
    mockRefreshTarget.mockResolvedValue({ ...TARGET, token: 'fresh-token' })

    const res = await call(path, { method })

    expect(res.status).toBe(200)
    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(forwardedInit(1).headers.get('authorization')).toBe('Bearer fresh-token')
  })

  it('gives up after one retry rather than looping', async () => {
    mockFetch.mockImplementation(async () => new Response('expired', { status: 401 }))
    mockRefreshTarget.mockResolvedValue({ ...TARGET, token: 'fresh-token' })

    const res = await call('/api/agents')

    expect(res.status).toBe(401)
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('returns the original 401 body when no fresh token can be obtained', async () => {
    mockFetch.mockResolvedValue(new Response('expired', { status: 401 }))
    mockRefreshTarget.mockResolvedValue(null)

    const res = await call('/api/agents')

    expect(res.status).toBe(401)
    expect(await res.text()).toBe('expired')
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('still refreshes for an unreplayable upload, so the user’s retry works', async () => {
    mockFetch.mockImplementation(async () => new Response('expired', { status: 401 }))
    mockRefreshTarget.mockResolvedValue({ ...TARGET, token: 'fresh-token' })

    // Chunked framing is how an undeclared-length upload actually arrives. The
    // body is a stream, consumed by the first attempt, so there is nothing to
    // replay. (The same case over a real socket: cloud-proxy.integration.test.ts.)
    const res = await call('/api/agents/x/files', {
      method: 'POST',
      headers: { 'transfer-encoding': 'chunked' },
      body: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('payload'))
          c.close()
        },
      }),
      // @ts-expect-error duplex is required for a stream body but absent from the DOM types
      duplex: 'half',
    })

    expect(res.status).toBe(401)
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(mockRefreshTarget).toHaveBeenCalledTimes(1)
  })
})

describe('cloud proxy boot prefetch', () => {
  // Main starts a switch's first calls before the reloading renderer can ask for
  // them; the proxy's job is to hand that flight over instead of opening a
  // second one. See cloud-boot-prefetch.ts.
  beforeEach(() => {
    _resetCloudBootPrefetchForTest()
  })

  it('answers from the request main already started', async () => {
    mockFetch.mockImplementation(async () => new Response('{"user":{"id":"u1"}}', { status: 200 }))
    startCloudBootPrefetch()
    const prefetchCalls = mockFetch.mock.calls.length

    const res = await call('/api/auth/get-session')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ user: { id: 'u1' } })
    // No second trip: the response came from the flight main opened.
    expect(mockFetch).toHaveBeenCalledTimes(prefetchCalls)
  })

  it('serves it once, so a refetch reaches the deployment', async () => {
    startCloudBootPrefetch()
    const prefetchCalls = mockFetch.mock.calls.length

    await call('/api/auth/get-session')
    await call('/api/auth/get-session')

    expect(mockFetch).toHaveBeenCalledTimes(prefetchCalls + 1)
  })

  it('ignores it for a conditional request, which is asking something else', async () => {
    startCloudBootPrefetch()
    const prefetchCalls = mockFetch.mock.calls.length

    await call('/api/agents', { headers: { 'if-none-match': 'W/"abc"' } })

    expect(mockFetch).toHaveBeenCalledTimes(prefetchCalls + 1)
    expect(forwardedUrl(prefetchCalls)).toBe(`${TARGET.deploymentUrl}/api/agents`)
  })

  it('leaves the entry for the renderer when the requester marks itself out', async () => {
    startCloudBootPrefetch()
    const prefetchCalls = mockFetch.mock.calls.length

    // A main-process poller (tray, app menu) racing the reload must not consume
    // the one-shot entry...
    await call('/api/agents', { headers: { [SKIP_BOOT_PREFETCH_HEADER]: '1' } })
    expect(mockFetch).toHaveBeenCalledTimes(prefetchCalls + 1)

    // ...so the renderer arriving second still gets its head start.
    await call('/api/agents')
    expect(mockFetch).toHaveBeenCalledTimes(prefetchCalls + 1)
  })

  it('ignores it for a write to the same path', async () => {
    startCloudBootPrefetch()
    const prefetchCalls = mockFetch.mock.calls.length

    await call('/api/agents', { method: 'POST' })

    expect(mockFetch).toHaveBeenCalledTimes(prefetchCalls + 1)
    expect(forwardedInit(prefetchCalls).method).toBe('POST')
  })

  it('strips the deployment\'s session cookies from a prefetched response too', async () => {
    mockFetch.mockImplementation(
      async () =>
        new Response('{}', {
          status: 200,
          headers: { 'set-cookie': 'session=secret', 'set-auth-token': 'token' },
        }),
    )
    startCloudBootPrefetch()
    const prefetchCalls = mockFetch.mock.calls.length

    const res = await call('/api/auth/get-session')

    // Assert the response came from the prefetch, or this passes for the wrong
    // reason: a forwarded response strips these headers too.
    expect(mockFetch).toHaveBeenCalledTimes(prefetchCalls)
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(res.headers.get('set-auth-token')).toBeNull()
  })
})
