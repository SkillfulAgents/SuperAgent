import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server } from 'node:http'
import { createRequire } from 'node:module'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { ErrorCode, LogLevel, WebClient, type ConversationsListResponse, type WebClientOptions } from '@slack/web-api'
import axios from 'axios'

// Exercise the real transports used by Bolt; mocking WebClient.apiCall would
// miss regressions in the upgraded Axios and follow-redirects dependencies.
const require = createRequire(import.meta.url)
const redirects = require('follow-redirects') as {
  http: {
    get: (url: string, options: Record<string, unknown>, callback: (response: IncomingMessage) => void) => {
      on: (name: string, callback: (error: Error) => void) => void
    }
  }
}
type Trust = (address: string, index?: number) => boolean
const proxyAddr = require('proxy-addr') as {
  (request: { socket: { remoteAddress: string }; headers: Record<string, string> }, trust: Trust): string
  compile: (subnets: string | string[]) => Trust
}

interface RequestRecord {
  method: string | undefined
  url: string | undefined
  headers: IncomingHttpHeaders
  body: string
}
interface Reply {
  status?: number
  headers?: Record<string, string>
  body?: unknown
}
const servers: Server[] = []

async function listen(handler: (request: RequestRecord) => Reply | undefined) {
  const requests: RequestRecord[] = []
  const server = createServer((request, response) => {
    const consume = async () => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const record = { method: request.method, url: request.url, headers: request.headers, body: Buffer.concat(chunks).toString() }
      requests.push(record)
      const reply = handler(record)
      // Undefined deliberately holds a request open for cancellation/timeout checks.
      if (!reply) return
      response.writeHead(reply.status ?? 200, { 'content-type': 'application/json', ...reply.headers })
      response.end(JSON.stringify(reply.body ?? { ok: true }))
    }
    consume().catch(error => response.destroy(error))
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected a loopback TCP listener')
  return { url: `http://127.0.0.1:${address.port}`, requests }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    if (!server.listening) return resolve()
    server.closeAllConnections()
    server.close(error => error ? reject(error) : resolve())
  })))
})

function slack(url: string, options: WebClientOptions = {}) {
  return new WebClient('xoxb-local-test', {
    slackApiUrl: `${url}/api/`,
    retryConfig: { retries: 0 },
    timeout: 1000,
    logLevel: LogLevel.ERROR,
    ...options,
  })
}

describe('Slack WebClient over its real HTTP transport', () => {
  it('preserves authentication, Unicode, Block Kit and thread form fields', async () => {
    const server = await listen(() => ({ body: { ok: true, ts: '123.456' } }))
    const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: '*hello* ✓' } }]
    const result = await slack(server.url).chat.postMessage({ channel: 'C_LOCAL', text: 'hello & ✓', blocks, thread_ts: '123.000', unfurl_links: false })
    expect(result.ts).toBe('123.456')
    expect(server.requests).toHaveLength(1)
    const request = server.requests[0]
    expect(request.method).toBe('POST')
    expect(request.url).toBe('/api/chat.postMessage')
    expect(request.headers.authorization).toBe('Bearer xoxb-local-test')
    expect(request.headers['content-type']).toContain('application/x-www-form-urlencoded')
    const body = new URLSearchParams(request.body)
    expect(body.get('channel')).toBe('C_LOCAL')
    expect(body.get('text')).toBe('hello & ✓')
    expect(body.get('blocks')).toBe(JSON.stringify(blocks))
    expect(body.get('thread_ts')).toBe('123.000')
    expect(body.get('unfurl_links')).toBe('false')
  })

  it('honors per-request tokens without leaking the constructor token into the form', async () => {
    const server = await listen(() => ({}))
    await slack(server.url).auth.test({ token: 'xoxb-local-override' })
    expect(server.requests[0].headers.authorization).toBe('Bearer xoxb-local-override')
    expect(server.requests[0].body).not.toContain('xoxb-local-test')
  })

  it('serializes multipart streams with filenames and adjacent fields', async () => {
    const server = await listen(() => ({}))
    await slack(server.url).apiCall('files.upload', { file: Readable.from(['local file ✓']), filename: 'sample.txt', channels: 'C_LOCAL' })
    const request = server.requests[0]
    expect(request.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/)
    expect(request.body).toContain('name="file"')
    expect(request.body).toContain('local file ✓')
    expect(request.body).toContain('sample.txt')
    expect(request.body).toContain('C_LOCAL')
  })

  it.each(['invalid_auth', 'channel_not_found', 'missing_scope'])('preserves Slack platform error %s', async error => {
    const server = await listen(() => ({ body: { ok: false, error } }))
    await expect(slack(server.url).auth.test()).rejects.toMatchObject({ code: ErrorCode.PlatformError, data: { error } })
    expect(server.requests).toHaveLength(1)
  })

  it('retains HTTP error classification when retries are disabled', async () => {
    const server = await listen(() => ({ status: 503, body: { error: 'temporarily unavailable' } }))
    await expect(slack(server.url).auth.test()).rejects.toMatchObject({ code: ErrorCode.HTTPError, statusCode: 503 })
  })

  it('retries a transient HTTP error and returns the successful result', async () => {
    let attempts = 0
    const server = await listen(() => ++attempts === 1 ? { status: 503 } : { body: { ok: true, user_id: 'U_LOCAL' } })
    const client = slack(server.url, { retryConfig: { retries: 1, minTimeout: 1, maxTimeout: 1, randomize: false } })
    expect((await client.auth.test()).user_id).toBe('U_LOCAL')
    expect(server.requests).toHaveLength(2)
  })

  it('reports rate limits with retry-after metadata', async () => {
    const server = await listen(() => ({ status: 429, headers: { 'retry-after': '2' } }))
    await expect(slack(server.url, { rejectRateLimitedCalls: true }).auth.test()).rejects.toMatchObject({ code: ErrorCode.RateLimitedError, retryAfter: 2 })
  })

  it('terminates a stalled request with a Slack request error', async () => {
    const server = await listen(() => undefined)
    await expect(slack(server.url, { timeout: 50 }).auth.test()).rejects.toMatchObject({ code: ErrorCode.RequestError })
  })

  it('uses each cursor when fetching paginated conversation lists', async () => {
    const server = await listen(request => {
      const cursor = new URLSearchParams(request.body).get('cursor')
      return { body: { ok: true, channels: [{ id: cursor ? 'C_SECOND' : 'C_FIRST' }], response_metadata: { next_cursor: cursor ? '' : 'next-page' } } }
    })
    const channels: string[] = []
    for await (const page of slack(server.url).paginate('conversations.list', { limit: 1 })) {
      const conversations = page as ConversationsListResponse
      channels.push(...(conversations.channels ?? []).map(channel => channel.id ?? ''))
    }
    expect(channels).toEqual(['C_FIRST', 'C_SECOND'])
    expect(server.requests).toHaveLength(2)
  })
})

describe('HTTP redirect and cancellation compatibility', () => {
  it('preserves credentials when following a same-origin redirect', async () => {
    const server = await listen(request => request.url === '/start' ? { status: 302, headers: { location: '/end' } } : {})
    await axios.get(`${server.url}/start`, { proxy: false, headers: { Authorization: 'Bearer local-test', Cookie: 'session=local-test' } })
    expect(server.requests[1].headers).toMatchObject({ authorization: 'Bearer local-test', cookie: 'session=local-test' })
  })

  it('strips credentials on a redirect to a different origin', async () => {
    const destination = await listen(() => ({}))
    const origin = await listen(() => ({ status: 302, headers: { location: destination.url } }))
    await axios.get(origin.url, { proxy: false, headers: { Authorization: 'Bearer local-test', Cookie: 'session=local-test', 'X-Public': 'keep' } })
    expect(destination.requests[0].headers.authorization).toBeUndefined()
    expect(destination.requests[0].headers.cookie).toBeUndefined()
    expect(destination.requests[0].headers['x-public']).toBe('keep')
  })

  it('normalizes array-form headers and escapes custom sensitive-header names', async () => {
    const destination = await listen(() => ({}))
    const origin = await listen(() => ({ status: 302, headers: { location: destination.url } }))
    await new Promise<void>((resolve, reject) => {
      redirects.http.get(origin.url, {
        headers: ['Authorization', 'Bearer local-test', 'X-Token$', 'local-secret', 'X-Public', 'keep'],
        sensitiveHeaders: ['X-Token$'],
      }, response => {
        response.resume()
        response.on('end', resolve)
        response.on('error', reject)
      }).on('error', reject)
    })
    expect(origin.requests[0].headers['x-token$']).toBe('local-secret')
    expect(destination.requests[0].headers.authorization).toBeUndefined()
    expect(destination.requests[0].headers['x-token$']).toBeUndefined()
    expect(destination.requests[0].headers['x-public']).toBe('keep')
  })

  it('preserves POST bodies across 307 redirects', async () => {
    const server = await listen(request => request.url === '/start' ? { status: 307, headers: { location: '/end' } } : {})
    await axios.post(`${server.url}/start`, { text: 'local message' }, { proxy: false })
    expect(server.requests[1]).toMatchObject({ method: 'POST', body: JSON.stringify({ text: 'local message' }) })
  })

  it('enforces the configured redirect limit', async () => {
    const server = await listen(() => ({ status: 302, headers: { location: '/again' } }))
    await expect(axios.get(server.url, { proxy: false, maxRedirects: 1 })).rejects.toMatchObject({ code: 'ERR_FR_TOO_MANY_REDIRECTS' })
    expect(server.requests).toHaveLength(2)
  })

  it('cancels a stalled request using AbortSignal', async () => {
    const server = await listen(() => undefined)
    await expect(axios.get(server.url, { proxy: false, signal: AbortSignal.timeout(50) })).rejects.toMatchObject({ code: 'ERR_CANCELED' })
  })
})

describe('proxy-addr trust boundaries', () => {
  it.each([
    ['192.0.2.0/24', '192.0.2.12', true],
    ['192.0.2.0/24', '192.0.3.12', false],
    ['192.0.2.0/24', '::ffff:192.0.2.12', true],
    ['2001:db8::/32', '2001:db8::12', true],
    ['2001:db8::/32', '2001:db9::12', false],
    ['::ffff:192.0.2.0/120', '192.0.2.12', true],
    ['::ffff:192.0.2.0/120', '::ffff:192.0.2.12', true],
    ['::ffff:192.0.2.0/120', '192.0.3.12', false],
    ['::ffff:0:0/80', '192.0.2.12', false],
    ['::ffff:0:0/80', '::ffff:192.0.2.12', false],
    ['::/1', '192.0.2.12', false],
    ['::/1', '::ffff:192.0.2.12', false],
    ['loopback', '127.0.0.1', true],
    ['loopback', '::1', true],
    ['loopback', 'not-an-address', false],
  ])('trust %s evaluates %s as %s', (subnet, address, expected) => {
    expect(proxyAddr.compile(subnet as string)(address as string)).toBe(expected)
    // Exercise both the single-subnet and multi-subnet implementation paths.
    expect(proxyAddr.compile([subnet as string, '198.51.100.0/24'])(address as string)).toBe(expected)
  })

  it('stops at the nearest untrusted hop instead of accepting a spoofed forwarded address', () => {
    const request = { socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': '203.0.113.7, 192.0.2.9' } }
    expect(proxyAddr(request, proxyAddr.compile('loopback'))).toBe('192.0.2.9')
    expect(proxyAddr(request, proxyAddr.compile(['loopback', '192.0.2.0/24']))).toBe('203.0.113.7')
  })

  it('ignores forwarding headers when the immediate peer is untrusted', () => {
    const request = { socket: { remoteAddress: '192.0.2.9' }, headers: { 'x-forwarded-for': '203.0.113.7' } }
    expect(proxyAddr(request, proxyAddr.compile('loopback'))).toBe('192.0.2.9')
  })
})
