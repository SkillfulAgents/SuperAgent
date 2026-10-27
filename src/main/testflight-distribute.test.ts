import crypto from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  AppStoreConnectError,
  appStoreConnectToken,
  createClient,
  distributeBuild,
  waitForBuild,
  type Client,
} from '../../scripts/lib/testflight'

type Handler = (body: unknown) => { status: number; json?: unknown }

/** A fake App Store Connect API: routes by "METHOD /path" (query ignored), and records every call. */
function fakeApi(routes: Record<string, Handler | Handler[]>) {
  const calls: { route: string; body: unknown }[] = []
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const { pathname } = new URL(String(url))
    const route = `${init?.method ?? 'GET'} ${pathname}`
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ route, body })
    const entry = routes[route]
    if (!entry) return new Response(JSON.stringify({ errors: [{ title: 'Not found', detail: route }] }), { status: 404 })
    const handler = Array.isArray(entry) ? (entry.length > 1 ? entry.shift()! : entry[0]) : entry
    const { status, json } = handler(body)
    return new Response(json === undefined ? null : JSON.stringify(json), { status })
  }) as typeof fetch
  return { client: createClient(() => 'token', fetchImpl), calls }
}

const ok = (json?: unknown): Handler => () => ({ status: json === undefined ? 204 : 200, json })
const builds = (...states: (string | null)[]): Handler[] =>
  states.map((state) => ok({ data: state === null ? [] : [{ id: 'build-1', attributes: { version: '412.1', processingState: state } }] }))
const groups = ok({
  data: [
    { id: 'team', attributes: { name: 'Team', isInternalGroup: true } },
    { id: 'beta', attributes: { name: 'Beta', isInternalGroup: false } },
  ],
})
const betaDetail = (externalBuildState: string, internalBuildState = 'READY_FOR_BETA_TESTING') =>
  ok({ data: { id: 'build-1', attributes: { internalBuildState, externalBuildState } } })

const wait = (client: Client, timeoutMs = 60_000) => {
  let clock = 0
  return waitForBuild(client, {
    appId: '6801340586', buildNumber: '412.1', platform: 'MAC_OS', timeoutMs, intervalMs: 30_000,
    sleep: async (ms) => { clock += ms }, now: () => clock, log: () => {},
  })
}

describe('appStoreConnectToken', () => {
  it('is an ES256 token Apple can verify, for the key and issuer, under 20 minutes long', () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
    const token = appStoreConnectToken({ keyId: 'KEY123', issuerId: 'issuer-1', privateKey: pem }, 1_000)
    const [header, payload, signature] = token.split('.')
    const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString())
    expect(decode(header)).toEqual({ alg: 'ES256', kid: 'KEY123', typ: 'JWT' })
    expect(decode(payload)).toEqual({ iss: 'issuer-1', iat: 1_000, exp: 1_900, aud: 'appstoreconnect-v1' })
    const valid = crypto.verify('sha256', Buffer.from(`${header}.${payload}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))
    expect(valid).toBe(true)
  })
})

describe('createClient', () => {
  it('reports Apple’s error title and detail with the status', async () => {
    const { client } = fakeApi({
      'GET /v1/builds': () => ({ status: 403, json: { errors: [{ title: 'Forbidden', detail: 'The API key lacks access' }] } }),
    })
    await expect(client.get('/v1/builds')).rejects.toThrow(new AppStoreConnectError(403, 'GET /v1/builds: 403 Forbidden: The API key lacks access'))
  })
})

describe('waitForBuild', () => {
  it('waits for the upload to appear and finish processing', async () => {
    const { client, calls } = fakeApi({ 'GET /v1/builds': builds(null, 'PROCESSING', 'VALID') })
    await expect(wait(client)).resolves.toBe('build-1')
    expect(calls).toHaveLength(3)
  })

  it('fails when App Store Connect rejects the build', async () => {
    const { client } = fakeApi({ 'GET /v1/builds': builds('PROCESSING', 'INVALID') })
    await expect(wait(client)).rejects.toThrow(/could not process build 412.1 \(INVALID\)/)
  })

  it('gives up after the timeout', async () => {
    const { client } = fakeApi({ 'GET /v1/builds': builds('PROCESSING') })
    await expect(wait(client, 90_000)).rejects.toThrow(/still PROCESSING after 2 min/)
  })
})

describe('distributeBuild', () => {
  const distribute = (client: Client, names = ['Team', 'Beta'], whatToTest?: string) =>
    distributeBuild(client, { appId: '6801340586', buildId: 'build-1', groups: names, whatToTest, log: () => {} })

  it('adds the build to every group and submits it for review when one is external', async () => {
    const { client, calls } = fakeApi({
      'GET /v1/apps/6801340586/betaGroups': groups,
      'GET /v1/builds/build-1/buildBetaDetail': betaDetail('READY_FOR_BETA_SUBMISSION'),
      'POST /v1/betaGroups/team/relationships/builds': ok(),
      'POST /v1/betaGroups/beta/relationships/builds': ok(),
      'POST /v1/betaAppReviewSubmissions': () => ({ status: 201, json: { data: { id: 'submission' } } }),
    })
    await distribute(client)
    const sent = calls.filter((c) => c.route.startsWith('POST'))
    expect(sent.map((c) => c.route)).toEqual([
      'POST /v1/betaGroups/team/relationships/builds',
      'POST /v1/betaGroups/beta/relationships/builds',
      'POST /v1/betaAppReviewSubmissions',
    ])
    expect(sent[0].body).toEqual({ data: [{ type: 'builds', id: 'build-1' }] })
    expect(sent[2].body).toEqual({ data: { type: 'betaAppReviewSubmissions', relationships: { build: { data: { type: 'builds', id: 'build-1' } } } } })
  })

  it('does not submit a build already waiting for or past review', async () => {
    const { client, calls } = fakeApi({
      'GET /v1/apps/6801340586/betaGroups': groups,
      'GET /v1/builds/build-1/buildBetaDetail': betaDetail('WAITING_FOR_BETA_REVIEW'),
      'POST /v1/betaGroups/team/relationships/builds': ok(),
      'POST /v1/betaGroups/beta/relationships/builds': ok(),
    })
    await distribute(client)
    expect(calls.map((c) => c.route)).not.toContain('POST /v1/betaAppReviewSubmissions')
  })

  it('submits nothing for internal groups only', async () => {
    const { client, calls } = fakeApi({
      'GET /v1/apps/6801340586/betaGroups': groups,
      'GET /v1/builds/build-1/buildBetaDetail': betaDetail('READY_FOR_BETA_SUBMISSION'),
      'POST /v1/betaGroups/team/relationships/builds': ok(),
    })
    await distribute(client, ['Team'])
    expect(calls.map((c) => c.route)).not.toContain('POST /v1/betaAppReviewSubmissions')
  })

  it('names the app’s groups when one does not exist, before changing anything', async () => {
    const { client, calls } = fakeApi({ 'GET /v1/apps/6801340586/betaGroups': groups })
    await expect(distribute(client, ['Team', 'Testers'])).rejects.toThrow('No TestFlight group named "Testers"; the app has "Team", "Beta"')
    expect(calls.filter((c) => !c.route.startsWith('GET'))).toEqual([])
  })

  it('stops before adding a build that is missing its export compliance answer', async () => {
    const { client, calls } = fakeApi({
      'GET /v1/apps/6801340586/betaGroups': groups,
      'GET /v1/builds/build-1/buildBetaDetail': betaDetail('READY_FOR_BETA_SUBMISSION', 'MISSING_EXPORT_COMPLIANCE'),
    })
    await expect(distribute(client)).rejects.toThrow(/export compliance/)
    expect(calls.filter((c) => !c.route.startsWith('GET'))).toEqual([])
  })

  it('writes What to Test, creating the en-US note or updating it', async () => {
    const routes = (localizations: unknown[]) => fakeApi({
      'GET /v1/apps/6801340586/betaGroups': groups,
      'GET /v1/builds/build-1/buildBetaDetail': betaDetail('WAITING_FOR_BETA_REVIEW'),
      'GET /v1/builds/build-1/betaBuildLocalizations': ok({ data: localizations }),
      'POST /v1/betaBuildLocalizations': () => ({ status: 201, json: { data: { id: 'loc-new' } } }),
      'PATCH /v1/betaBuildLocalizations/loc-1': ok({ data: { id: 'loc-1' } }),
      'POST /v1/betaGroups/team/relationships/builds': ok(),
    })
    const created = routes([])
    await distribute(created.client, ['Team'], 'Gamut 0.6.0-rc.2')
    expect(created.calls.find((c) => c.route === 'POST /v1/betaBuildLocalizations')?.body).toEqual({
      data: {
        type: 'betaBuildLocalizations',
        attributes: { locale: 'en-US', whatsNew: 'Gamut 0.6.0-rc.2' },
        relationships: { build: { data: { type: 'builds', id: 'build-1' } } },
      },
    })
    const updated = routes([{ id: 'loc-1', attributes: { locale: 'en-US' } }])
    await distribute(updated.client, ['Team'], 'Gamut 0.6.0-rc.2')
    expect(updated.calls.find((c) => c.route === 'PATCH /v1/betaBuildLocalizations/loc-1')?.body).toEqual({
      data: { type: 'betaBuildLocalizations', id: 'loc-1', attributes: { whatsNew: 'Gamut 0.6.0-rc.2' } },
    })
  })
})
