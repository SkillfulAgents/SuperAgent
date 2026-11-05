import { createHash } from 'node:crypto'
import { z } from 'zod'
import { WorkspaceFileError } from '@shared/lib/agent-actor/workspace-path'
import { addErrorBreadcrumb, captureException } from '@shared/lib/error-reporting'
import { attribution, runWithAttribution, type Attribution } from '@shared/lib/platform-attribution'
import { getRequestUserId } from '@shared/lib/platform-attribution/request-context'
import { getPlatformProxyBaseUrl } from '@shared/lib/platform-auth/config'
import { retryAfterSeconds } from './remote-request-pacer'
import type { S3Access } from './s3-client'
import { S3StorageVolume } from './s3-mountable-volume'
import { s3LocationSchema, type S3Location } from './s3-schema'
import { VolumeError } from './volume-error'
import { volumeFolderBrowser, volumeFolderCreator } from './volume-folder-browser'
import { volumeFolderNameSchema } from './volume-folders-schema'
import { platformVolumeIdSchema, type StoredPlatformVolumeConfig } from './volume-config-schema'

const driveSchema = z.object({ id: platformVolumeIdSchema, name: z.string(), createdAt: z.string() })
const grantSchema = z.object({
  location: s3LocationSchema,
  credentials: z.object({ accessKeyId: z.string(), secretAccessKey: z.string(), sessionToken: z.string(), expiration: z.coerce.date() }),
})
const errorSchema = z.object({ error: z.object({ message: z.string(), type: z.string().optional(), code: z.string().optional() }) })

// Resolving the member reads the database, and rclone makes a request per file operation, so an
// answer is kept briefly. A connection change drops them all.
const MEMBER_MS = 30_000
const members = new Map<string, { member: Promise<Attribution | null>; until: number }>()

/** The member a drive call acts as: the agent's (its owner on hosted), else the signed-in user's. */
async function actingMember(agentSlug?: string): Promise<Attribution> {
  const key = JSON.stringify([agentSlug ?? null, getRequestUserId() ?? null])
  const now = Date.now()
  let entry = members.get(key)
  if (!entry || entry.until <= now) {
    for (const [other, { until }] of members) if (until <= now) members.delete(other)
    const resolving = { member: agentSlug ? attribution.forAgent(agentSlug) : attribution.current(), until: now + MEMBER_MS }
    resolving.member.catch(() => { if (members.get(key) === resolving) members.delete(key) })
    members.set(key, resolving)
    entry = resolving
  }
  const auth = await entry.member
  if (!auth || !getPlatformProxyBaseUrl()) throw new WorkspaceFileError('not-accessible', 'Sign in to Gamut to use Gamut drives')
  return auth
}

interface PlatformCall { op: 'list' | 'create' | 'credentials'; method: 'GET' | 'POST'; route: string; body?: unknown }

// During an outage every file operation fails the same way: one report a minute per kind, with a count.
const REPORT_MS = 60_000
const reports = new Map<string, { until: number; suppressed: number }>()

/** Logs and reports a platform answer this app cannot use. Never tokens or keys. */
function report(call: PlatformCall, failure: 'network' | 'timeout' | 'shape' | 'status', error: unknown, details: { status?: number } & Record<string, unknown>): void {
  const kind = `${call.op}|${failure}|${details.status ?? ''}`
  const previous = reports.get(kind)
  if (previous && previous.until > Date.now()) { previous.suppressed++; return }
  reports.set(kind, { until: Date.now() + REPORT_MS, suppressed: 0 })
  const extra = { method: call.method, route: `/v1/volumes${call.route}`, ...details, ...(previous?.suppressed ? { suppressedSinceLastReport: previous.suppressed } : {}) }
  console.warn(`[volumes] Gamut drive ${call.op} failed (${failure})`, extra)
  captureException(error, { tags: { area: 'gamut-drives', op: call.op, failure, ...(details.status ? { status: String(details.status) } : {}) }, extra })
}

const unavailable = (message = 'Gamut drives are unavailable. Please try again.', retryAfter?: number) => new VolumeError(message, 503, retryAfter)

/** The platform's answer, and when it sent it by its own clock, if it said. */
async function platformRequest<T>(auth: Attribution, call: PlatformCall, schema: z.ZodType<T>): Promise<{ data: T; sentAt?: number }> {
  const headers = new Headers({ 'Content-Type': 'application/json' })
  auth.applyTo(headers)
  const started = Date.now()
  let response: Response
  try {
    response = await runWithAttribution(auth, () => fetch(`${getPlatformProxyBaseUrl()}/v1/volumes${call.route}`, {
      method: call.method, headers, signal: AbortSignal.timeout(15_000),
      ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
    }))
  } catch (error) {
    const failure = error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network'
    addErrorBreadcrumb({ category: 'gamut-drives', message: `${call.method} /v1/volumes${call.route}`, level: 'warning', data: { failure } })
    report(call, failure, error, { durationMs: Date.now() - started })
    throw unavailable()
  }
  // cf-ray finds the request in the platform's logs.
  const ray = response.headers.get('cf-ray')
  const seen = { status: response.status, durationMs: Date.now() - started, ...(ray ? { ray } : {}) }
  addErrorBreadcrumb({ category: 'gamut-drives', message: `${call.method} /v1/volumes${call.route}`, level: response.ok ? 'info' : 'warning', data: seen })
  const body: unknown = await response.json().catch(() => null)
  if (response.ok) {
    const parsed = schema.safeParse(body)
    if (parsed.success) {
      const sentAt = Date.parse(response.headers.get('date') ?? '')
      return { data: parsed.data, ...(Number.isFinite(sentAt) ? { sentAt } : {}) }
    }
    // Paths and codes only: a credentials answer holds keys.
    report(call, 'shape', new Error(`Unexpected Gamut drive ${call.op} response`), { ...seen, issues: parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.code}`) })
    throw unavailable()
  }
  const error = errorSchema.safeParse(body)
  const message = error.success ? error.data.error.message : undefined
  const retryAfter = retryAfterSeconds(response)
  if (error.success && error.data.error.code === 'not-accessible') throw new WorkspaceFileError('not-accessible', message)
  if (response.status === 429) throw new VolumeError(message ?? 'Gamut drives are busy. Please try again shortly.', 429, retryAfter)
  // A rejected sign-in is the user's to fix, so it keeps the platform's message.
  const status = response.status === 401 ? 403 : response.status
  if (message && (status === 400 || status === 403 || status === 409)) throw new VolumeError(message, status)
  report(call, 'status', new Error(`Gamut drive ${call.op} answered ${response.status}`), { ...seen, platformError: error.success ? error.data.error : undefined })
  throw unavailable(status === 503 ? message : undefined, retryAfter)
}

async function listDrives(auth: Attribution): Promise<z.infer<typeof driveSchema>[]> {
  return (await platformRequest(auth, { op: 'list', method: 'GET', route: '' }, z.object({ volumes: z.array(driveSchema) }))).data.volumes
}

/** A saved definition names a drive of the member's org, which the picker found or made. */
export async function preparePlatformVolume(config: StoredPlatformVolumeConfig): Promise<{ name: string; config: StoredPlatformVolumeConfig }> {
  const auth = await actingMember()
  const drive = (await listDrives(auth)).find(item => item.id === config.volumeId)
  if (!drive) throw new VolumeError('Gamut drive not found', 404)
  return { name: drive.name, config: { volumeId: drive.id } }
}

const sameLocation = (a: S3Location, b: S3Location) =>
  a.endpoint === b.endpoint && a.region === b.region && a.bucket === b.bucket && a.prefix === b.prefix && a.forcePathStyle === b.forcePathStyle

interface Grant {
  location: S3Location
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken: string }
  /** When the keys expire, and when renewal begins, by this machine's clock. */
  expiresAt: number
  renewAt: number
  /** How far this machine's clock runs ahead of the platform's. */
  clockOffsetMs: number
}

// Volumes are built per request, so keys outlive them here, one entry per drive and acting member.
// Members never share keys. Entries are reused until their last 5 minutes, or their second half
// for keys that live shorter.
const grants = new Map<string, Promise<Grant>>()
const expiries = new Set<NodeJS.Timeout>()
const RENEW_MS = 5 * 60_000

/** Called when the Gamut connection changes, so no key or member outlives the connection it came from. */
export function dropPlatformVolumeKeys(): void {
  grants.clear()
  members.clear()
  for (const timer of expiries) clearTimeout(timer)
  expiries.clear()
}

async function fetchGrant(volumeId: string, auth: Attribution): Promise<Grant> {
  const { data, sentAt } = await platformRequest(auth, { op: 'credentials', method: 'POST', route: `/${encodeURIComponent(volumeId)}/credentials` }, grantSchema)
  const now = Date.now()
  // The expiry is by the platform's clock. Measured against this machine's, a fast clock would see
  // the keys as nearly expired and fetch new ones on every call.
  const clockOffsetMs = sentAt === undefined ? 0 : now - sentAt
  const { expiration, ...credentials } = data.credentials
  const expiresAt = expiration.getTime() + clockOffsetMs
  return { location: data.location, credentials, expiresAt, renewAt: expiresAt - Math.min(RENEW_MS, Math.max(0, expiresAt - now) / 2), clockOffsetMs }
}

// Personal keys all share one attribution key, so the slot names the bearer itself. Members are
// cached, so each one's bearer is hashed once.
const bearers = new WeakMap<Attribution, string>()
function slotOf(volumeId: string, auth: Attribution): string {
  let bearer = bearers.get(auth)
  if (!bearer) bearers.set(auth, bearer = createHash('sha256').update(auth.bearerToken()).digest('hex'))
  return `${volumeId}|${auth.getKey()}|${bearer}`
}

async function grantFor(volumeId: string, auth: Attribution): Promise<Grant> {
  const slot = slotOf(volumeId, auth)
  for (;;) {
    const entry = grants.get(slot)
    if (entry) {
      // A failed fetch fails everyone waiting on it; its handler below clears the slot for the next call.
      const grant = await entry
      if (Date.now() < grant.renewAt) return grant
      // Callers that waited on the same stale entry share whichever refresh starts first.
      if (grants.get(slot) !== entry) continue
    }
    const forget = () => { if (grants.get(slot) === pending) grants.delete(slot) }
    // Slots for members or keys no longer in use leave once their keys expire.
    const pending: Promise<Grant> = fetchGrant(volumeId, auth).then(grant => {
      const timer = setTimeout(() => { expiries.delete(timer); forget() }, Math.max(0, grant.expiresAt - Date.now()))
      timer.unref()
      expiries.add(timer)
      return grant
    }, (error: unknown) => { forget(); throw error })
    grants.set(slot, pending)
    return pending
  }
}

/** Opens a drive for one request: names the member, proves they hold keys, and learns where it lives. */
async function platformAccess(volumeId: string, agentSlug?: string): Promise<S3Access> {
  const auth = await actingMember(agentSlug)
  const grant = await grantFor(volumeId, auth)
  // Later keys must be for the same place, or this opened volume cannot use them.
  const keysFor = async (member: Attribution) => {
    const next = await grantFor(volumeId, member)
    if (!sameLocation(next.location, grant.location)) throw new WorkspaceFileError('not-accessible', 'This Gamut drive moved. Please try again.')
    return next
  }
  return {
    location: grant.location,
    // Listings are shared by every member the drive's keys are issued to; each opened volume proved its own.
    cacheKey: `platform:${volumeId}`,
    clockOffsetMs: grant.clockOffsetMs,
    // A long transfer outlives its first keys; later ones are this member's too.
    credentials: async () => {
      const next = await keysFor(auth)
      return { ...next.credentials, expiration: new Date(next.expiresAt) }
    },
    // A change is published only while there is still a member holding keys for this place.
    recheck: async () => { await keysFor(await actingMember(agentSlug)) },
  }
}

/** A drive in the org's bucket: the S3 source, with its location and short-lived keys from the platform. */
export class PlatformMountableVolume extends S3StorageVolume<StoredPlatformVolumeConfig> {
  readonly type = 'platform'

  static readonly browseFolders = volumeFolderBrowser(z.object({}), async () => ({
    folders: (await listDrives(await actingMember())).map(drive => ({ id: drive.id, name: drive.name })),
  }))

  // The name becomes the drive's folder in every agent: checked here, before the platform creates it.
  static readonly createFolder = volumeFolderCreator(z.object({ name: volumeFolderNameSchema }), async ({ name }) => {
    const drive = (await platformRequest(await actingMember(), { op: 'create', method: 'POST', route: '', body: { name } }, driveSchema)).data
    return { folder: { id: drive.id, name: drive.name } }
  })

  constructor(id: string, name: string, config: StoredPlatformVolumeConfig, agentSlug?: string) {
    super(id, name, config, () => platformAccess(config.volumeId, agentSlug), agentSlug)
  }

  get sourceLabel(): string { return 'Gamut drive' }
}
