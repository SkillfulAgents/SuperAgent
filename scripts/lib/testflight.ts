// Helpers for scripts/testflight-distribute.ts: sign App Store Connect API
// requests, wait for an uploaded build to finish processing, and hand it to
// TestFlight groups, submitting it for Beta App Review when a group is external.
// Plain fetch and node:crypto, so the release job needs no SDK.
import crypto from 'node:crypto'

const API = 'https://api.appstoreconnect.apple.com'

export interface ApiKey {
  keyId: string
  issuerId: string
  /** The key's .p8 file contents (PKCS#8 PEM). */
  privateKey: string
}

/** A token for the App Store Connect API: ES256, at most 20 minutes long, as Apple requires. */
export function appStoreConnectToken(key: ApiKey, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const header = encode({ alg: 'ES256', kid: key.keyId, typ: 'JWT' })
  const payload = encode({ iss: key.issuerId, iat: nowSeconds, exp: nowSeconds + 15 * 60, aud: 'appstoreconnect-v1' })
  const signature = crypto.sign('sha256', Buffer.from(`${header}.${payload}`), {
    key: crypto.createPrivateKey(key.privateKey),
    dsaEncoding: 'ieee-p1363',
  })
  return `${header}.${payload}.${signature.toString('base64url')}`
}

export class AppStoreConnectError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

export interface Resource {
  id: string
  attributes?: Record<string, unknown>
}

export interface Client {
  get(path: string): Promise<{ data: Resource | Resource[] | null }>
  /** A write; a create answers with the new resource. */
  send(method: 'POST' | 'PATCH', path: string, body: object): Promise<{ data: Resource | Resource[] | null }>
}

/** A client that signs each request afresh, so a long wait never outlives its token. */
export function createClient(token: () => string, fetchImpl: typeof fetch = fetch): Client {
  async function request(method: string, path: string, body?: object) {
    const res = await fetchImpl(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    const text = await res.text()
    if (!res.ok) {
      let detail = text
      try {
        const errors = (JSON.parse(text) as { errors?: { title?: string; detail?: string }[] }).errors ?? []
        if (errors.length > 0) detail = errors.map((e) => [e.title, e.detail].filter(Boolean).join(': ')).join('; ')
      } catch {
        // Not JSON: keep the body as it came.
      }
      throw new AppStoreConnectError(res.status, `${method} ${path}: ${res.status} ${detail}`)
    }
    return text ? (JSON.parse(text) as { data: Resource | Resource[] | null }) : { data: null }
  }
  return {
    get: (path) => request('GET', path),
    send: (method, path, body) => request(method, path, body),
  }
}

export interface WaitOptions {
  appId: string
  /** CFBundleVersion, e.g. 412.1. */
  buildNumber: string
  platform: 'MAC_OS' | 'IOS'
  timeoutMs: number
  intervalMs: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  log?: (line: string) => void
}

/**
 * The build's id once App Store Connect has processed it. An upload shows up as
 * a build a few minutes after altool returns, then processes for several more.
 */
export async function waitForBuild(client: Client, options: WaitOptions): Promise<string> {
  const { sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = Date.now, log = console.log } = options
  const query = new URLSearchParams({
    'filter[app]': options.appId,
    'filter[version]': options.buildNumber,
    'filter[preReleaseVersion.platform]': options.platform,
    'fields[builds]': 'version,processingState',
    limit: '2',
  })
  const deadline = now() + options.timeoutMs
  let last = ''
  for (;;) {
    const { data } = await client.get(`/v1/builds?${query}`)
    const builds = Array.isArray(data) ? data : []
    if (builds.length > 1) throw new Error(`More than one ${options.platform} build numbered ${options.buildNumber}`)
    const state = builds.length === 1 ? String(builds[0].attributes?.processingState) : 'not there yet'
    if (state !== last) log(`Build ${options.buildNumber}: ${state}`)
    last = state
    if (state === 'VALID') return builds[0].id
    if (state === 'FAILED' || state === 'INVALID') {
      throw new Error(`App Store Connect could not process build ${options.buildNumber} (${state}); Apple emails the reason`)
    }
    if (now() >= deadline) {
      throw new Error(`Build ${options.buildNumber} was still ${state} after ${Math.round(options.timeoutMs / 60000)} min`)
    }
    await sleep(options.intervalMs)
  }
}

export interface DistributeOptions {
  appId: string
  buildId: string
  /** TestFlight group names, internal or external. */
  groups: string[]
  /** "What to Test" for the build's testers, in en-US. */
  whatToTest?: string
  log?: (line: string) => void
}

// An external build already submitted or past review needs no new submission.
const SUBMITTABLE = 'READY_FOR_BETA_SUBMISSION'

/**
 * Adds the build to each group, and submits it for Beta App Review when one is
 * external. Only the first build of a version gets a full review; Apple may
 * approve later builds of that version without one. Apple reviews one build of
 * a version at a time, so while another is in review this one is left to
 * submit by hand, with a warning.
 */
export async function distributeBuild(client: Client, options: DistributeOptions): Promise<void> {
  const { log = console.log } = options
  const { data } = await client.get(`/v1/apps/${options.appId}/betaGroups?fields[betaGroups]=name,isInternalGroup&limit=200`)
  const existing = Array.isArray(data) ? data : []
  const groups = options.groups.map((name) => {
    const group = existing.find((g) => g.attributes?.name === name)
    if (!group) {
      throw new Error(`No TestFlight group named "${name}"; the app has ${existing.map((g) => `"${String(g.attributes?.name)}"`).join(', ') || 'none'}`)
    }
    return { id: group.id, name, internal: group.attributes?.isInternalGroup === true }
  })

  const detail = (await client.get(`/v1/builds/${options.buildId}/buildBetaDetail`)).data as Resource
  if (detail.attributes?.internalBuildState === 'MISSING_EXPORT_COMPLIANCE') {
    throw new Error('The build is missing its export compliance answer (ITSAppUsesNonExemptEncryption in Info.plist)')
  }

  if (options.whatToTest) await setWhatToTest(client, options.buildId, options.whatToTest)

  for (const group of groups) {
    await client.send('POST', `/v1/betaGroups/${group.id}/relationships/builds`, { data: [{ type: 'builds', id: options.buildId }] })
    log(`Added to ${group.name} (${group.internal ? 'internal' : 'external'})`)
  }

  if (groups.every((group) => group.internal)) return
  const externalState = String(detail.attributes?.externalBuildState)
  if (externalState !== SUBMITTABLE) {
    log(`Beta App Review: not submitted again, the build is ${externalState}`)
    return
  }
  const inReview = await otherBuildInReview(client, options.buildId)
  if (inReview) {
    log(`::warning title=Not submitted for Beta App Review::Build ${inReview} of this version is in review, and Apple reviews one at a time. Submit this build in TestFlight once that one is approved or rejected.`)
    return
  }
  await client.send('POST', '/v1/betaAppReviewSubmissions', {
    data: { type: 'betaAppReviewSubmissions', relationships: { build: { data: { type: 'builds', id: options.buildId } } } },
  })
  log('Submitted for Beta App Review')
}

/** The number of another build of the same version waiting for or in Beta App Review, if there is one. */
async function otherBuildInReview(client: Client, buildId: string): Promise<string | undefined> {
  const train = (await client.get(`/v1/builds/${buildId}/preReleaseVersion?fields[preReleaseVersions]=version`)).data as Resource
  const query = new URLSearchParams({
    'filter[preReleaseVersion]': train.id,
    'filter[betaAppReviewSubmission.betaReviewState]': 'WAITING_FOR_REVIEW,IN_REVIEW',
    'fields[builds]': 'version',
    limit: '200',
  })
  const { data } = await client.get(`/v1/builds?${query}`)
  const other = (Array.isArray(data) ? data : []).find((build) => build.id !== buildId)
  return other ? String(other.attributes?.version) : undefined
}

async function setWhatToTest(client: Client, buildId: string, whatsNew: string): Promise<void> {
  const { data } = await client.get(`/v1/builds/${buildId}/betaBuildLocalizations?fields[betaBuildLocalizations]=locale`)
  const english = (Array.isArray(data) ? data : []).find((l) => l.attributes?.locale === 'en-US')
  if (english) {
    await client.send('PATCH', `/v1/betaBuildLocalizations/${english.id}`, {
      data: { type: 'betaBuildLocalizations', id: english.id, attributes: { whatsNew } },
    })
  } else {
    await client.send('POST', '/v1/betaBuildLocalizations', {
      data: {
        type: 'betaBuildLocalizations',
        attributes: { locale: 'en-US', whatsNew },
        relationships: { build: { data: { type: 'builds', id: buildId } } },
      },
    })
  }
}
