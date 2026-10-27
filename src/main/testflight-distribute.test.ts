import crypto from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { prepareAppStoreVersion } from '../../scripts/lib/app-store-version'
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
/** The build's version, and the builds of it in Beta App Review. */
const reviewRoutes = (...inReview: { id: string; attributes: { version: string } }[]) => ({
  'GET /v1/builds/build-1/preReleaseVersion': ok({ data: { id: 'train-1', attributes: { version: '0.6.0' } } }),
  'GET /v1/builds': ok({ data: inReview }),
})

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
      ...reviewRoutes(),
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

  it('warns instead of submitting while another build of the version is in review', async () => {
    const lines: string[] = []
    const { client, calls } = fakeApi({
      'GET /v1/apps/6801340586/betaGroups': groups,
      'GET /v1/builds/build-1/buildBetaDetail': betaDetail('READY_FOR_BETA_SUBMISSION'),
      ...reviewRoutes({ id: 'build-0', attributes: { version: '411.1' } }),
      'POST /v1/betaGroups/team/relationships/builds': ok(),
      'POST /v1/betaGroups/beta/relationships/builds': ok(),
    })
    await distributeBuild(client, { appId: '6801340586', buildId: 'build-1', groups: ['Team', 'Beta'], log: (line) => lines.push(line) })
    expect(calls.map((c) => c.route)).toContain('POST /v1/betaGroups/beta/relationships/builds')
    expect(calls.map((c) => c.route)).not.toContain('POST /v1/betaAppReviewSubmissions')
    expect(lines.at(-1)).toMatch(/^::warning title=Not submitted for Beta App Review::Build 411\.1 of this version is in review/)
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

describe('prepareAppStoreVersion', () => {
  const version = (id: string, versionString: string, appVersionState: string, createdDate: string) =>
    ({ id, attributes: { versionString, appVersionState, createdDate } })
  const prepare = (client: Client, versionString: string) => prepareAppStoreVersion(client, {
    appId: '6801340586', platform: 'MAC_OS', versionString, buildId: 'build-9', whatsNew: 'Bug fixes and improvements.', log: () => {},
  })
  const writes = (calls: { route: string; body: unknown }[]) => calls.filter((c) => !c.route.startsWith('GET'))
  const attachBuild = (versionId: string) => ({
    route: `PATCH /v1/appStoreVersions/${versionId}/relationships/build`, body: { data: { type: 'builds', id: 'build-9' } },
  })
  const listing = { locale: 'en-US', description: 'Gamut on your Mac', keywords: 'agents', promotionalText: 'Promo', marketingUrl: 'https://www.gamut.so', supportUrl: 'https://www.gamut.so/docs' }

  it('gives the version being prepared the release’s number and build, with no What’s New on a first version', async () => {
    const { client, calls } = fakeApi({
      'GET /v1/apps/6801340586/appStoreVersions': ok({ data: [version('v1', '0.5.50', 'PREPARE_FOR_SUBMISSION', '2026-10-27')] }),
      'PATCH /v1/appStoreVersions/v1': ok({ data: { id: 'v1' } }),
      'PATCH /v1/appStoreVersions/v1/relationships/build': ok(),
      'GET /v1/appStoreVersions/v1/appStoreVersionLocalizations': ok({ data: [{ id: 'l1', attributes: { ...listing, whatsNew: null } }] }),
    })
    await expect(prepare(client, '0.6.0')).resolves.toBe('updated')
    expect(writes(calls)).toEqual([
      { route: 'PATCH /v1/appStoreVersions/v1', body: { data: { type: 'appStoreVersions', id: 'v1', attributes: { versionString: '0.6.0' } } } },
      attachBuild('v1'),
    ])
  })

  it('only attaches the build when the version being prepared has the number already', async () => {
    const { client, calls } = fakeApi({
      'GET /v1/apps/6801340586/appStoreVersions': ok({ data: [version('v1', '0.6.0', 'PREPARE_FOR_SUBMISSION', '2026-10-27')] }),
      'PATCH /v1/appStoreVersions/v1/relationships/build': ok(),
      'GET /v1/appStoreVersions/v1/appStoreVersionLocalizations': ok({ data: [] }),
    })
    await prepare(client, '0.6.0')
    expect(writes(calls)).toEqual([attachBuild('v1')])
  })

  it('makes a new version once the last is out, copies the listing App Store Connect left out, and writes What’s New', async () => {
    const { client, calls } = fakeApi({
      'GET /v1/apps/6801340586/appStoreVersions': ok({ data: [
        version('v0', '0.5.50', 'REPLACED_WITH_NEW_VERSION', '2026-10-01'),
        version('v1', '0.6.0', 'READY_FOR_DISTRIBUTION', '2026-11-01'),
      ] }),
      'POST /v1/appStoreVersions': () => ({ status: 201, json: { data: { id: 'v2' } } }),
      'PATCH /v1/appStoreVersions/v2/relationships/build': ok(),
      'GET /v1/appStoreVersions/v1/appStoreVersionLocalizations': ok({ data: [{ id: 's1', attributes: { ...listing, whatsNew: 'Last time' } }] }),
      'GET /v1/appStoreVersions/v2/appStoreVersionLocalizations': ok({ data: [] }),
      'POST /v1/appStoreVersionLocalizations': () => ({ status: 201, json: { data: { id: 'l2' } } }),
    })
    await expect(prepare(client, '0.7.0')).resolves.toBe('created')
    expect(writes(calls)).toEqual([
      {
        route: 'POST /v1/appStoreVersions',
        body: { data: {
          type: 'appStoreVersions',
          attributes: { platform: 'MAC_OS', versionString: '0.7.0', releaseType: 'MANUAL' },
          relationships: { app: { data: { type: 'apps', id: '6801340586' } } },
        } },
      },
      attachBuild('v2'),
      {
        route: 'POST /v1/appStoreVersionLocalizations',
        body: { data: {
          type: 'appStoreVersionLocalizations',
          attributes: { ...listing, whatsNew: 'Bug fixes and improvements.' },
          relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: 'v2' } } },
        } },
      },
    ])
  })

  it('keeps the listing App Store Connect copied, and What’s New someone already wrote', async () => {
    const routes = (whatsNew: string | null) => fakeApi({
      'GET /v1/apps/6801340586/appStoreVersions': ok({ data: [
        version('v1', '0.6.0', 'READY_FOR_DISTRIBUTION', '2026-11-01'),
        version('v2', '0.7.0', 'PREPARE_FOR_SUBMISSION', '2026-11-20'),
      ] }),
      'PATCH /v1/appStoreVersions/v2/relationships/build': ok(),
      'GET /v1/appStoreVersions/v2/appStoreVersionLocalizations': ok({ data: [{ id: 'l2', attributes: { ...listing, whatsNew } }] }),
      'PATCH /v1/appStoreVersionLocalizations/l2': ok({ data: { id: 'l2' } }),
    })
    const blank = routes(null)
    await prepare(blank.client, '0.7.0')
    expect(writes(blank.calls)).toEqual([
      attachBuild('v2'),
      {
        route: 'PATCH /v1/appStoreVersionLocalizations/l2',
        body: { data: { type: 'appStoreVersionLocalizations', id: 'l2', attributes: { whatsNew: 'Bug fixes and improvements.' } } },
      },
    ])
    const written = routes('Faster agents, and Choose folder again.')
    await prepare(written.client, '0.7.0')
    expect(writes(written.calls)).toEqual([attachBuild('v2')])
  })

  it('changes nothing while a version is in review, or when this version is out already', async () => {
    const inReview = fakeApi({
      'GET /v1/apps/6801340586/appStoreVersions': ok({ data: [
        version('v1', '0.6.0', 'READY_FOR_DISTRIBUTION', '2026-11-01'),
        version('v2', '0.7.0', 'WAITING_FOR_REVIEW', '2026-11-20'),
      ] }),
    })
    await expect(prepare(inReview.client, '0.7.1')).resolves.toBe('version in review')
    expect(writes(inReview.calls)).toEqual([])

    const out = fakeApi({
      'GET /v1/apps/6801340586/appStoreVersions': ok({ data: [version('v1', '0.6.0', 'READY_FOR_DISTRIBUTION', '2026-11-01')] }),
    })
    await expect(prepare(out.client, '0.6.0')).resolves.toBe('released already')
    expect(writes(out.calls)).toEqual([])
  })
})
