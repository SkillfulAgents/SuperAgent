import { createHash } from 'node:crypto'
import { z } from 'zod'
import { WorkspaceFileError } from '@shared/lib/agent-actor/workspace-path'
import { attribution, runWithAttribution, type Attribution } from '@shared/lib/platform-attribution'
import { getPlatformProxyBaseUrl } from '@shared/lib/platform-auth/config'
import type { S3KeySource } from './s3-client'
import { S3StorageVolume } from './s3-mountable-volume'
import { s3LocationSchema, type S3Location } from './s3-schema'
import { VolumeError } from './volume-error'
import { volumeFolderBrowser } from './volume-folder-browser'
import type { PlatformVolumeConfig, StoredPlatformVolumeConfig } from './volume-config-schema'

const driveSchema = z.object({ id: z.string(), name: z.string(), createdAt: z.string() })
const grantSchema = z.object({
  location: s3LocationSchema,
  credentials: z.object({ accessKeyId: z.string(), secretAccessKey: z.string(), sessionToken: z.string(), expiration: z.coerce.date() }),
})
type Grant = z.infer<typeof grantSchema>
const errorSchema = z.object({ error: z.object({ message: z.string(), code: z.string().optional() }) })

/** The member a drive call acts as: the agent's (its owner on hosted), else the signed-in user's. */
async function actingMember(agentSlug?: string): Promise<Attribution> {
  const auth = agentSlug ? await attribution.forAgent(agentSlug) : await attribution.current()
  if (!auth || !getPlatformProxyBaseUrl()) throw new WorkspaceFileError('not-accessible', 'Sign in to Gamut to use Gamut drives')
  return auth
}

const unavailable = () => new VolumeError('Gamut drives are unavailable. Please try again.', 503)

async function platformRequest<T>(auth: Attribution, route: string, schema: z.ZodType<T>, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const headers = new Headers({ 'Content-Type': 'application/json' })
  auth.applyTo(headers)
  let response: Response
  try {
    response = await runWithAttribution(auth, () => fetch(`${getPlatformProxyBaseUrl()}/v1/volumes${route}`, {
      method: init.method ?? 'GET', headers, signal: AbortSignal.timeout(15_000),
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }))
  } catch { throw unavailable() }
  const body: unknown = await response.json().catch(() => null)
  if (response.ok) {
    const parsed = schema.safeParse(body)
    if (!parsed.success) throw unavailable()
    return parsed.data
  }
  const error = errorSchema.safeParse(body)
  if (error.success && error.data.error.code === 'not-accessible') throw new WorkspaceFileError('not-accessible')
  // A rejected sign-in is the user's to fix, so it keeps the platform's message.
  const status = response.status === 401 ? 403 : response.status
  if (error.success && (status === 400 || status === 403 || status === 404 || status === 409 || status === 429 || status === 503)) {
    throw new VolumeError(error.data.error.message, status)
  }
  throw unavailable()
}

async function listDrives(): Promise<z.infer<typeof driveSchema>[]> {
  return (await platformRequest(await actingMember(), '', z.object({ volumes: z.array(driveSchema) }))).volumes
}

/** A saved definition names a drive of the member's org, created here when setup sent a name.
 * Its first keys say where it lives, and the definition records that location. */
export async function preparePlatformVolume(config: PlatformVolumeConfig): Promise<{ name: string; config: StoredPlatformVolumeConfig }> {
  const auth = await actingMember()
  if ('name' in config) {
    const drive = await platformRequest(auth, '', driveSchema, { method: 'POST', body: { name: config.name } })
    const { location } = await grantFor(drive.id, auth).catch(() => {
      throw new VolumeError(`"${drive.name}" was created but is unavailable right now. Pick it from the list to try again.`, 503)
    })
    return { name: drive.name, config: { ...location, volumeId: drive.id } }
  }
  const drive = (await listDrives()).find(item => item.id === config.volumeId)
  if (!drive) throw new VolumeError('Gamut drive not found', 404)
  const { location } = await grantFor(drive.id, auth)
  return { name: drive.name, config: { ...location, volumeId: drive.id } }
}

const sameLocation = (a: S3Location, b: S3Location) =>
  a.endpoint === b.endpoint && a.region === b.region && a.bucket === b.bucket && a.prefix === b.prefix && a.forcePathStyle === b.forcePathStyle

// Volumes are built per request, so keys outlive them here, one entry per drive and acting member.
// Members never share keys. Entries are reused until their last 5 minutes.
const grants = new Map<string, Promise<Grant>>()
const expiries = new Set<NodeJS.Timeout>()
const REFRESH_MS = 5 * 60_000

/** Called when the Gamut connection changes, so no key outlives the member it was issued to. */
export function dropPlatformVolumeKeys(): void {
  grants.clear()
  for (const timer of expiries) clearTimeout(timer)
  expiries.clear()
}

async function grantFor(volumeId: string, auth: Attribution): Promise<Grant> {
  // Personal keys all share one attribution key, so the slot names the bearer itself.
  const slot = `${volumeId}|${auth.getKey()}|${createHash('sha256').update(auth.bearerToken()).digest('hex')}`
  for (;;) {
    const entry = grants.get(slot)
    if (entry) {
      // A failed fetch fails everyone waiting on it; its handler below clears the slot for the next call.
      const grant = await entry
      if (grant.credentials.expiration.getTime() - Date.now() > REFRESH_MS) return grant
      // Callers that waited on the same stale entry share whichever refresh starts first.
      if (grants.get(slot) !== entry) continue
    }
    const pending = platformRequest(auth, `/${encodeURIComponent(volumeId)}/credentials`, grantSchema, { method: 'POST' })
    grants.set(slot, pending)
    const forget = () => { if (grants.get(slot) === pending) grants.delete(slot) }
    // Slots for members or keys no longer in use leave once their keys expire.
    pending.then(grant => {
      const timer = setTimeout(() => { expiries.delete(timer); forget() }, Math.max(0, grant.credentials.expiration.getTime() - Date.now()))
      timer.unref()
      expiries.add(timer)
    }, forget)
    return pending
  }
}

function platformKeys(config: StoredPlatformVolumeConfig, agentSlug?: string): S3KeySource {
  const checkedGrant = async () => {
    const grant = await grantFor(config.volumeId, await actingMember(agentSlug))
    if (!sameLocation(grant.location, config)) throw new WorkspaceFileError('not-accessible', 'This Gamut drive moved. Remove it and add it again.')
    return grant
  }
  return {
    cacheKey: `platform:${config.volumeId}`,
    credentials: async () => (await checkedGrant()).credentials,
    // Cached listings are shared across members, so every operation first proves this one has a grant.
    authorize: async () => { await checkedGrant() },
  }
}

/** A drive in the org's bucket: the S3 source, with its location and short-lived keys from the platform. */
export class PlatformMountableVolume extends S3StorageVolume<StoredPlatformVolumeConfig> {
  readonly type = 'platform'

  static readonly browseFolders = volumeFolderBrowser(z.object({}), async () => ({
    folders: (await listDrives()).map(drive => ({ id: drive.id, name: drive.name })),
  }))

  constructor(id: string, name: string, config: StoredPlatformVolumeConfig, agentSlug?: string) {
    super(id, name, config, platformKeys(config, agentSlug), agentSlug)
  }

  get sourceLabel(): string { return 'Gamut drive' }
}
