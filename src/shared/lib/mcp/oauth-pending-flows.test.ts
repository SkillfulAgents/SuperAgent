import * as dnsPromises from 'node:dns/promises'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { appState } from '@shared/lib/app-state'
import type { McpOAuthFlowRecord } from './oauth-pending-flow-schema'
import {
  claimPendingFlow,
  MCP_OAUTH_CLAIM_TTL_MS,
  mcpOAuthFlowKey,
} from './oauth-pending-flows'

// Two copies of the OAuth module stand for two processes serving one tenant:
// each has its own module state, and AppState, held on globalThis, is the one
// thing they share. A flow kept in a module-level map fails every test here
// that starts on one copy and finishes on the other.

const db = vi.hoisted(() => ({
  insertValues: vi.fn(),
  updateSet: vi.fn(),
  updateWhere: vi.fn(),
  selectLimit: vi.fn(),
}))
const provider = vi.hoisted(() => ({ token: vi.fn<(body: URLSearchParams) => Promise<Response>>() }))

vi.mock('node:dns/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns/promises')>()
  return { ...actual, lookup: vi.fn() }
})
vi.mock('@shared/lib/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: db.selectLimit }) }) }),
    insert: () => ({ values: db.insertValues }),
    update: () => ({ set: (values: unknown) => { db.updateSet(values); return { where: db.updateWhere } } }),
  },
}))
vi.mock('@shared/lib/db/schema', () => ({ remoteMcpServers: { id: 'id' } }))
vi.mock('drizzle-orm', () => ({ eq: (col: string, val: string) => ({ col, val }) }))

const ISSUER = 'https://auth.example.com'
const CODE = 'auth-code-0f3d9'
const CLIENT_SECRET = 'client-secret-7b21'
const ACCESS_TOKEN = 'access-token-c4e8'
const REFRESH_TOKEN = 'refresh-token-91aa'
const LOOPBACK = 'http://localhost:47891/api/remote-mcps/oauth-callback'
// The ticket's lifetime, written out rather than imported, so a changed constant fails here.
const FIFTEEN_MINUTES = 15 * 60_000

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}
function tokens(): Response {
  return json({ access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN, expires_in: 3600, token_type: 'Bearer' })
}

// The MCP server and its authorization server, by URL, so concurrent calls get
// the right answers in any order.
const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit): Promise<Response> => {
  const url = String(input)
  switch (url) {
    case 'https://mcp.example.com/mcp':
      return new Response(null, {
        status: 401,
        headers: { 'WWW-Authenticate': 'Bearer resource_metadata="https://mcp.example.com/.well-known/res"' },
      })
    case 'https://mcp.example.com/.well-known/res':
      return json({ resource: 'https://mcp.example.com', authorization_servers: [ISSUER] })
    case `${ISSUER}/.well-known/oauth-authorization-server`:
      return json({
        issuer: ISSUER,
        authorization_response_iss_parameter_supported: true,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        registration_endpoint: `${ISSUER}/register`,
      })
    case `${ISSUER}/register`:
      return json({ client_id: 'dyn-client', client_secret: CLIENT_SECRET }, 201)
    case `${ISSUER}/token`:
      return provider.token(new URLSearchParams(String(init?.body)))
    default:
      return new Response('not found', { status: 404 })
  }
})
vi.stubGlobal('fetch', fetchMock)

import * as first from './oauth'

type OAuthModule = typeof first
let second: OAuthModule
beforeAll(async () => {
  vi.resetModules()
  second = await import('./oauth')
  expect(second.completeOAuthFlow).not.toBe(first.completeOAuthFlow)
})

beforeEach(() => {
  vi.clearAllMocks()
  ;(dnsPromises.lookup as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ address: '93.184.216.34', family: 4 })
  provider.token.mockReset().mockImplementation(async () => tokens())
  db.insertValues.mockReset().mockResolvedValue(undefined)
  db.updateWhere.mockReset().mockResolvedValue(undefined)
  db.selectLimit.mockReset().mockResolvedValue([])
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function start(instance: OAuthModule, options: { electron?: boolean } = {}): Promise<string> {
  const redirects = options.electron ? ['superagent://mcp-oauth-callback', LOOPBACK] : [LOOPBACK]
  const started = await instance.initiateNewServerOAuth('https://mcp.example.com/mcp', 'Probe', redirects, options.electron ?? false, 'user-1')
  expect(started).not.toBeNull()
  return started!.state
}
async function stored(state: string) {
  return appState().get(mcpOAuthFlowKey(state))
}
async function verifierOf(state: string): Promise<string> {
  const entry = await stored(state)
  if (entry?.value.state !== 'pending') throw new Error(`flow is ${entry?.value.state ?? 'absent'}`)
  return entry.value.exchange.codeVerifier
}
function exchanges(): number {
  return provider.token.mock.calls.length
}

/** Makes AppState writes of one kind land and then lose their answer, `times` times. */
function loseAnswers(state: McpOAuthFlowRecord['state'], times = 1, after?: () => void) {
  const store = appState()
  const real = store.compareAndSet.bind(store)
  let left = times
  return vi.spyOn(store, 'compareAndSet').mockImplementation(async (key, expected, value, options) => {
    const written = await real(key, expected, value, options)
    if (left > 0 && (value as McpOAuthFlowRecord).state === state) {
      left--
      after?.()
      throw new Error('AppState unavailable')
    }
    return written
  })
}

describe('MCP OAuth flows across processes', () => {
  it('completes a sign-in whose callback reaches another process', async () => {
    const state = await start(first)
    const verifier = await verifierOf(state)

    const result = await second.completeOAuthFlow(state, CODE, ISSUER)

    expect(result).toMatchObject({ success: true, electron: false, redirectWasScheme: false })
    expect(exchanges()).toBe(1)
    const body = provider.token.mock.calls[0][0]
    expect(Object.fromEntries(body)).toEqual({
      grant_type: 'authorization_code',
      code: CODE,
      redirect_uri: LOOPBACK,
      client_id: 'dyn-client',
      client_secret: CLIENT_SECRET,
      code_verifier: verifier,
      resource: 'https://mcp.example.com',
    })
    expect(db.insertValues).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      id: result.mcpId,
      name: 'Probe',
      url: 'https://mcp.example.com/mcp',
      userId: 'user-1',
      accessToken: ACCESS_TOKEN,
      refreshToken: REFRESH_TOKEN,
      oauthClientSecret: CLIENT_SECRET,
    }))
    // Used: what is left holds no secret.
    const tombstone = await stored(state)
    expect(tombstone?.value.state).toBe('finished')
    expect(JSON.stringify(tombstone)).not.toContain(verifier)
    expect(JSON.stringify(tombstone)).not.toContain(CLIENT_SECRET)
  })

  it('carries the desktop delivery context to the process that answers the callback', async () => {
    const state = await start(first, { electron: true })
    const result = await second.completeOAuthFlow(state, CODE, ISSUER)
    expect(result).toMatchObject({ success: true, electron: true, redirectWasScheme: true, desktopProtocol: 'superagent' })
  })

  it('re-authorizes an existing server from another process, writing only its row', async () => {
    db.selectLimit.mockResolvedValue([{ id: 'mcp-1', oauthClientId: null }])
    const started = await first.initiateOAuthFlow('mcp-1', 'https://mcp.example.com/mcp', [LOOPBACK])
    db.updateSet.mockClear()

    const result = await second.completeOAuthFlow(started!.state, CODE, ISSUER)

    expect(result).toMatchObject({ success: true, mcpId: 'mcp-1' })
    expect(db.updateSet).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ accessToken: ACCESS_TOKEN, status: 'active' }))
    expect(db.updateWhere).toHaveBeenLastCalledWith({ col: 'id', val: 'mcp-1' })
    expect(db.insertValues).not.toHaveBeenCalled()
  })

  it('exchanges the code once when duplicate callbacks race on two processes', async () => {
    const state = await start(first)

    const results = await Promise.all([first, second, first, second, first, second].map(instance => instance.completeOAuthFlow(state, CODE, ISSUER)))

    expect(exchanges()).toBe(1)
    expect(db.insertValues).toHaveBeenCalledTimes(1)
    expect(results.filter(result => result.success)).toHaveLength(1)
    for (const refused of results.filter(result => !result.success)) {
      expect(refused.error).toMatch(/already being completed|already used/)
    }
  })

  it('leaves the flow for the right callback after a wrong-issuer one', async () => {
    const state = await start(first)
    const before = await stored(state)

    const forged = await second.completeOAuthFlow(state, 'forged-code', 'https://evil.example.com')
    expect(forged).toMatchObject({ success: false, error: expect.stringMatching(/expected authorization server/) })
    const forgedError = await second.validateAndConsumeOAuthErrorResponse(state, 'https://evil.example.com')
    expect(forgedError.valid).toBe(false)
    expect(exchanges()).toBe(0)
    expect((await stored(state))?.revision).toBe(before?.revision)

    expect(await first.completeOAuthFlow(state, CODE, ISSUER)).toMatchObject({ success: true })
    expect(exchanges()).toBe(1)
  })

  it('lets the right callback win when a wrong-issuer one arrives at the same time', async () => {
    const state = await start(first)
    const [forged, genuine] = await Promise.all([
      second.completeOAuthFlow(state, 'forged-code', 'https://evil.example.com'),
      first.completeOAuthFlow(state, CODE, ISSUER),
    ])
    expect(forged.success).toBe(false)
    expect(genuine.success).toBe(true)
    expect(exchanges()).toBe(1)
    expect(Object.fromEntries(provider.token.mock.calls[0][0]).code).toBe(CODE)
  })

  it('ends a flow on a genuine error response answered by another process', async () => {
    const state = await start(first)
    expect(await second.validateAndConsumeOAuthErrorResponse(state, ISSUER)).toMatchObject({ valid: true, electron: false })
    expect(await first.completeOAuthFlow(state, CODE, ISSUER)).toMatchObject({
      success: false,
      error: expect.stringMatching(/already used/),
    })
    expect(exchanges()).toBe(0)
  })
})

describe('MCP OAuth flow expiry', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }))

  it('completes a callback in the last millisecond of the flow', async () => {
    const state = await start(first)
    vi.setSystemTime(Date.now() + FIFTEEN_MINUTES - 1)
    expect(await second.completeOAuthFlow(state, CODE, ISSUER)).toMatchObject({ success: true })
  })

  it('fails an expired flow cleanly, saying so, without an exchange', async () => {
    const state = await start(first)
    vi.setSystemTime(Date.now() + FIFTEEN_MINUTES)

    expect(await second.completeOAuthFlow(state, CODE, ISSUER)).toEqual({
      success: false,
      error: 'This sign-in has expired or was already used. Start the connection again',
    })
    expect(await second.validateAndConsumeOAuthErrorResponse(state, ISSUER)).toMatchObject({ valid: false })
    expect(exchanges()).toBe(0)
    expect(db.insertValues).not.toHaveBeenCalled()
  })

  it('ends a flow whose claimant died when the claim lapses, not 15 minutes later', async () => {
    const state = await start(first)
    // A process claims the flow and dies before finishing it.
    expect((await claimPendingFlow(state, ISSUER)).claimed).toBe(true)

    expect(await second.completeOAuthFlow(state, CODE, ISSUER)).toMatchObject({
      success: false,
      error: 'This sign-in is already being completed',
    })
    vi.setSystemTime(Date.now() + MCP_OAUTH_CLAIM_TTL_MS)
    expect(await second.completeOAuthFlow(state, CODE, ISSUER)).toMatchObject({
      success: false,
      error: expect.stringMatching(/expired or was already used/),
    })
    expect(await stored(state)).toBeNull()
    expect(exchanges()).toBe(0)
  })

  it('drops the tokens of a holder whose claim lapsed before its exchange returned', async () => {
    const state = await start(first)
    let answer!: () => void
    provider.token.mockImplementation(() => new Promise(resolve => { answer = () => resolve(tokens()) }))

    const slow = first.completeOAuthFlow(state, CODE, ISSUER)
    await vi.waitFor(() => expect(exchanges()).toBe(1))
    // The machine sleeps mid-exchange; meanwhile the user may start over.
    vi.setSystemTime(Date.now() + MCP_OAUTH_CLAIM_TTL_MS)
    answer()

    expect(await slow).toMatchObject({ success: false, error: expect.stringMatching(/took too long/) })
    expect(db.insertValues).not.toHaveBeenCalled()
  })
})

describe('MCP OAuth token exchange failures', () => {
  it('finishes the flow when the provider rejects the code, so it is never sent again', async () => {
    const state = await start(first)
    provider.token.mockResolvedValueOnce(json({ error: 'invalid_grant', error_description: 'Code expired' }, 400))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    expect((await first.completeOAuthFlow(state, CODE, ISSUER)).success).toBe(false)
    expect(await second.completeOAuthFlow(state, CODE, ISSUER)).toMatchObject({
      success: false,
      error: expect.stringMatching(/already used/),
    })
    expect(exchanges()).toBe(1)
    expect(db.insertValues).not.toHaveBeenCalled()
  })

  it('finishes the flow when the exchange gets no answer, which may have spent the code', async () => {
    const state = await start(first)
    provider.token.mockRejectedValueOnce(new TypeError('fetch failed'))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    expect((await second.completeOAuthFlow(state, CODE, ISSUER)).success).toBe(false)
    expect((await first.completeOAuthFlow(state, CODE, ISSUER)).success).toBe(false)
    expect(exchanges()).toBe(1)
  })

  it('exchanges once when the claim lands and its answer is lost', async () => {
    const state = await start(first)
    loseAnswers('claimed')

    expect(await second.completeOAuthFlow(state, CODE, ISSUER)).toMatchObject({ success: true })
    expect(exchanges()).toBe(1)
    expect(db.insertValues).toHaveBeenCalledTimes(1)
  })

  it('fails cleanly when a claim lands and AppState stays down, and the flow ends at the claim lapse', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const state = await start(first)
    const store = appState()
    const realGet = store.get.bind(store)
    let down = false
    vi.spyOn(store, 'get').mockImplementation(async key => {
      if (down) throw new Error('AppState unavailable')
      return realGet(key)
    })
    loseAnswers('claimed', 1, () => { down = true })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(await first.completeOAuthFlow(state, CODE, ISSUER)).toMatchObject({
      success: false,
      error: 'Could not finish the sign-in. Try again',
    })
    down = false
    expect((await second.completeOAuthFlow(state, CODE, ISSUER)).error).toBe('This sign-in is already being completed')
    vi.setSystemTime(Date.now() + MCP_OAUTH_CLAIM_TTL_MS)
    expect((await second.completeOAuthFlow(state, CODE, ISSUER)).error).toMatch(/expired or was already used/)
    expect(exchanges()).toBe(0)
  })

  it('writes the credentials once when the finishing write lands and its answer is lost', async () => {
    const state = await start(first)
    loseAnswers('finished')

    expect(await second.completeOAuthFlow(state, CODE, ISSUER)).toMatchObject({ success: true })
    expect(db.insertValues).toHaveBeenCalledTimes(1)
    expect((await stored(state))?.value.state).toBe('finished')
  })

  it('gives back a claim answered too late, unspent, for the next callback', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const state = await start(first)
    const pending = await stored(state)
    // The claim lands, and its answer takes 25 s: too late for a 30 s exchange inside a 60 s claim.
    const store = appState()
    const real = store.compareAndSet.bind(store)
    const slowClaim = vi.spyOn(store, 'compareAndSet').mockImplementation(async (key, expected, value, options) => {
      const written = await real(key, expected, value, options)
      if ((value as McpOAuthFlowRecord).state === 'claimed') vi.setSystemTime(Date.now() + 25_000)
      return written
    })

    expect(await first.completeOAuthFlow(state, CODE, ISSUER)).toMatchObject({
      success: false,
      error: 'Could not finish the sign-in in time. Try again',
    })
    expect(exchanges()).toBe(0)
    const released = await stored(state)
    expect(released?.value).toEqual(pending?.value)
    expect(released?.expiresAt).toBe(pending?.expiresAt)

    slowClaim.mockRestore()
    expect(await second.completeOAuthFlow(state, CODE, ISSUER)).toMatchObject({ success: true })
    expect(exchanges()).toBe(1)
  })

  it('reports a credential write that failed, without retrying the exchange', async () => {
    const state = await start(first)
    db.insertValues.mockRejectedValueOnce(new Error('database is locked'))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(await first.completeOAuthFlow(state, CODE, ISSUER)).toMatchObject({
      success: false,
      error: expect.stringMatching(/Could not save the connection/),
    })
    expect((await second.completeOAuthFlow(state, CODE, ISSUER)).error).toMatch(/already used/)
    expect(exchanges()).toBe(1)
  })
})

describe('MCP OAuth secrets', () => {
  it('keeps the code, verifier, client secret, tokens and state out of logs, errors and events', async () => {
    const logged: unknown[][] = []
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { logged.push(args) })
    }
    const published = vi.spyOn(appState(), 'publish')
    // A token short enough for a JSON parse error to quote it whole.
    const shortToken = 'qk-551'
    const secrets: string[] = [CODE, CLIENT_SECRET, ACCESS_TOKEN, REFRESH_TOKEN, shortToken]
    const results: unknown[] = []
    const run = async (prepare: () => void, callbacks = 1) => {
      const state = await start(first)
      secrets.push(state, await verifierOf(state))
      prepare()
      for (let i = 0; i < callbacks; i++) results.push(await (i % 2 ? first : second).completeOAuthFlow(state, CODE, ISSUER))
    }

    // Success, then a duplicate.
    await run(() => {}, 2)
    // A rejected code.
    await run(() => provider.token.mockResolvedValueOnce(json({ error: 'invalid_grant', error_description: 'Code expired' }, 400)))
    // A token endpoint that answers form-encoded, which is not JSON.
    await run(() => provider.token.mockResolvedValueOnce(new Response(`access_token=${ACCESS_TOKEN}&refresh_token=${REFRESH_TOKEN}`, { status: 200 })))
    // Broken JSON.
    await run(() => provider.token.mockResolvedValueOnce(new Response(`{"access_token":${shortToken}}`, { status: 200 })))
    // A failed write whose error quotes the statement's parameters, as drizzle's does.
    await run(() => db.insertValues.mockRejectedValueOnce(new Error(
      `Failed query: insert into "remote_mcp_servers" params: ${ACCESS_TOKEN},${REFRESH_TOKEN},${CLIENT_SECRET}`,
      { cause: new Error('database is locked') },
    )))
    // Lost answers.
    await run(() => loseAnswers('claimed'))
    // A wrong issuer on a pending flow, an unknown state.
    await run(() => {}, 0)
    results.push(await second.completeOAuthFlow(secrets.at(-2)!, CODE, 'https://evil.example.com'))
    results.push(await second.completeOAuthFlow('unknown-state', CODE, ISSUER))

    const text = JSON.stringify(results) + logged.flat().map(asText).join('\n')
    expect(logged.length).toBeGreaterThan(0)
    for (const secret of secrets) expect(text).not.toContain(secret)
    expect(published).not.toHaveBeenCalled()
  })
})

function asText(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack}\n${asText(value.cause)}`
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}
