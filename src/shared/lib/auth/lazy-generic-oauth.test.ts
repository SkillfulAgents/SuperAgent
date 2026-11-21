/** The discovery-attempt sharing that lazy-generic-oauth.ts adds around upstream's retry hook. */
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { background, backgroundSettled } from '../background'
import { lazyGenericOAuth } from './lazy-generic-oauth'

type Plugin = ReturnType<typeof lazyGenericOAuth<'p'>>

let server: Server
let issuer: string
let discoveryRequests = 0
let gate: Promise<void> = Promise.resolve()
let release: () => void = () => {}
const unhandled: unknown[] = []
const onUnhandled = (reason: unknown) => { unhandled.push(reason) }

/** Hold discovery responses until the test releases them, so concurrent callers overlap. */
function hold() {
  gate = new Promise<void>((resolve) => { release = resolve })
}

beforeEach(async () => {
  discoveryRequests = 0
  gate = Promise.resolve()
  release = () => {}
  server = createServer((_request, response) => {
    discoveryRequests++
    background(gate.then(() => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`, id_token_signing_alg_values_supported: ['RS256'],
      }))
    }), { name: 'lazy-generic-oauth-test.http' })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  issuer = `http://127.0.0.1:${address.port}`
  process.on('unhandledRejection', onUnhandled)
})

afterEach(async () => {
  release()
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await backgroundSettled()
  process.off('unhandledRejection', onUnhandled)
  unhandled.length = 0
})

function plugin(extra: Record<string, unknown> = {}): Plugin {
  return lazyGenericOAuth({
    config: [{
      providerId: 'p', clientId: 'c', requireIdTokenVerification: true,
      discoveryUrl: `${issuer}/.well-known/openid-configuration`, ...extra,
    }],
  })
}

/** One auth instance's context, built the way Better Auth runs the plugin's init. */
async function instance(p: Plugin) {
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
  const context: Record<string, unknown> = { socialProviders: [], logger, baseURL: 'http://app', options: {} }
  Object.assign(context, (await p.init(context as never)).context)
  const [hook] = p.hooks.before
  // Each request sees its own shallow copy of the context, as Better Auth's dispatch does.
  const call = (input: { body?: unknown; params?: unknown }) => {
    const hookInput = { context: { ...context }, query: {}, headers: new Headers(), returnHeaders: true, ...input } as never
    expect(hook.matcher(hookInput)).toBe(true)
    return Promise.resolve(hook.handler(hookInput))
  }
  return {
    signIn: () => call({ body: { provider: 'p' } }),
    callback: () => call({ params: { id: 'p' } }),
    providers: () => (context.socialProviders as { id: string }[]).map((provider) => provider.id),
    pending: () => context.genericOAuthPendingDiscovery as Map<string, unknown>,
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 50))

describe('lazyGenericOAuth discovery sharing', () => {
  it('lets a sign-in and a callback share one attempt', async () => {
    const auth = await instance(plugin())
    hold()
    const signIn = auth.signIn()
    await vi.waitFor(() => expect(discoveryRequests).toBe(1))
    const callback = auth.callback()
    await tick()
    release()
    await Promise.all([signIn, callback])
    expect(discoveryRequests).toBe(1)
    expect(auth.providers()).toEqual(['p'])
    expect(auth.pending().has('p')).toBe(false)
  })

  it('gives a joiner none of the first caller’s hook result', async () => {
    const auth = await instance(plugin())
    hold()
    const first = auth.signIn()
    await vi.waitFor(() => expect(discoveryRequests).toBe(1))
    const joiner = auth.signIn()
    await tick()
    release()
    await first
    expect(await joiner).toBeUndefined()
    expect(discoveryRequests).toBe(1)
  })

  it('clears a rejected attempt: both callers see the error, the next call retries', async () => {
    // A secret with a secretless token auth method makes upstream's provider build throw.
    const auth = await instance(plugin({ clientSecret: 's', tokenEndpointAuth: { method: 'none' } }))
    hold()
    const first = auth.signIn()
    await vi.waitFor(() => expect(discoveryRequests).toBe(1))
    const joiner = auth.callback()
    await tick()
    release()
    const results = await Promise.allSettled([first, joiner])
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected'])
    expect(discoveryRequests).toBe(1)

    await expect(auth.signIn()).rejects.toThrow(/cannot be combined with clientSecret/)
    expect(discoveryRequests).toBe(2)
    expect(auth.pending().has('p')).toBe(true)
    await tick()
    expect(unhandled).toEqual([])
  })

  it('does not share an attempt between two auth instances of one plugin', async () => {
    const shared = plugin()
    const [a, b] = await Promise.all([instance(shared), instance(shared)])
    hold()
    const first = a.signIn()
    await vi.waitFor(() => expect(discoveryRequests).toBe(1))
    const second = b.signIn()
    await vi.waitFor(() => expect(discoveryRequests).toBe(2))
    release()
    await Promise.all([first, second])
    expect(a.providers()).toEqual(['p'])
    expect(b.providers()).toEqual(['p'])
  })
})
