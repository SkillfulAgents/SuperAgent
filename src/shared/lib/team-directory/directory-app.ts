/**
 * Connecting a directory with its provisioning credentials alone (Slack: the
 * refresh token of an app configuration token). The host creates the
 * directory's own app with them, a person installs it in one click on the
 * provider's page, and the install gives the directory's credentials. The
 * provisioning credentials stay on the directory for agents' apps, and the app
 * is deleted with the directory. The same for every provider whose
 * provisioning has `directoryApp`; see docs/team-directory.md.
 *
 * An install is held in AppState under a random id until it is installed,
 * started over (which deletes its app), or runs out of time. The provider's
 * page carries the id and a secret as its `state`.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@shared/lib/db'
import { teamDirectories } from '@shared/lib/db/schema'
import { appState, defineNamespace } from '@shared/lib/app-state'
import { background } from '@shared/lib/background'
import { captureException } from '@shared/lib/error-reporting'
import { logAuditEvent } from '@shared/lib/services/audit-log-service'
import { listDirectoryNow } from './cache'
import { openDirectoryCredentials, sealDirectoryCredentials } from './credentials'
import { loadProvisioning, provisioningOf, saveProvisioningCredentials } from './provisioning'
import { getDirectoryProvider } from './registry'
import { saveDirectoryConnection, type DirectoryConnection } from './store'
import { DirectoryConnectError, type AgentIdentityProvisioner, type ProvisionedAppRecord, type TeamDirectoryProvider } from './types'
import { directoryInstallOutcomeSchema, type DirectoryInstallStatus } from './view-schema'

/** How long an install can be finished. */
export const DIRECTORY_INSTALL_TTL_MS = 30 * 60_000
/** What a pending install is sealed for, until its workspace is known. */
const PENDING_TENANT = 'pending-install'

const appRecordSchema = z.record(z.string(), z.unknown())
const sealedPendingSchema = z.object({ credentials: z.unknown(), app: appRecordSchema })

/** An install the host started. */
const installs = defineNamespace({
  name: 'oauth:directory-app-install',
  consistency: 'strong',
  schema: z.object({
    /** SHA-256 of the secret half of the install's `state`. */
    secretDigest: z.string(),
    provider: z.string(),
    /** `{ credentials, app }` sealed: the provisioning credentials, rotated already, and the app made with them. */
    sealed: z.string(),
    redirectUrl: z.string().url(),
    userId: z.string().nullable(),
  }),
  expiry: { ttlMs: DIRECTORY_INSTALL_TTL_MS, onUpdate: 'keep' },
})
type PendingInstall = z.infer<typeof installs.schema>

/** How an install went, for the Settings page that started it. */
const outcomes = defineNamespace({
  name: 'oauth:directory-app-install-outcome',
  consistency: 'strong',
  schema: directoryInstallOutcomeSchema,
  expiry: { ttlMs: DIRECTORY_INSTALL_TTL_MS, onUpdate: 'reset' },
})

const sealedPendingAs = (provider: string) => `${provider}:directory-app-install`
const sealedAppAs = (provider: string) => `${provider}:directory-app`
const digest = (secret: string) => createHash('sha256').update(secret).digest()
const isHttps = (url: string | null) => !!url && URL.parse(url)?.protocol === 'https:'

/**
 * Whether a provider's directory can be connected with its provisioning
 * credentials alone, on this host: the install must be able to return to
 * `redirectUrl`.
 */
export function connectsWithProvisioning(provider: TeamDirectoryProvider<unknown>, redirectUrl: string | null): boolean {
  const provisioning = provisioningOf({ provider: provider.info.id })
  return !!provisioning?.directoryApp && (!provisioning.httpsRedirectsOnly || isHttps(redirectUrl))
}

async function deleteQuietly(provisioner: AgentIdentityProvisioner, app: ProvisionedAppRecord, operation: string): Promise<void> {
  try {
    await provisioner.deleteApp(app)
  } catch (error) {
    captureException(error, { tags: { component: 'team-directory', operation } })
  }
}

/**
 * Verifies the provisioning credentials an admin pasted, creates the
 * directory's app with them, and returns the provider's page that installs it.
 * `installId` reads how the install went (`directoryInstallOutcome`).
 */
export async function startDirectoryAppConnect(input: {
  provider: string
  credentials: unknown
  redirectUrl: string
  userId: string | null
}): Promise<{ installId: string; url: string }> {
  const provider = getDirectoryProvider(input.provider)
  const provisioning = provider && provisioningOf({ provider: input.provider })
  const label = provider?.info.label ?? input.provider
  if (!provisioning?.directoryApp) throw new DirectoryConnectError(`${label} can’t be connected with a token alone.`)
  // Before verifying: that may spend the credentials.
  if (provisioning.httpsRedirectsOnly && !isHttps(input.redirectUrl)) {
    throw new DirectoryConnectError(`${label} only returns to an HTTPS address, and this app is at ${URL.parse(input.redirectUrl)?.origin ?? input.redirectUrl}. Use a ${label} app you already have.`)
  }
  const credentials = await provisioning.verify(provisioning.credentialsSchema.parse(input.credentials))
  // The pasted credentials may be retired by now (a rotation): a failure from here on needs new ones.
  let created
  let url: URL
  try {
    created = await provisioning.directoryApp.create(credentials, { redirectUrl: input.redirectUrl })
    const parsed = URL.parse(created.installUrl)
    if (!parsed) throw new Error(`The provider returned an install URL that does not parse: ${created.installUrl}`)
    url = parsed
  } catch (error) {
    if (error instanceof DirectoryConnectError) throw error
    captureException(error, { tags: { component: 'team-directory', operation: 'create-directory-app' } })
    throw new DirectoryConnectError(`${label} did not create the app. Generate a new token and try again.`)
  }
  const installId = randomBytes(18).toString('base64url')
  const secret = randomBytes(24).toString('base64url')
  await appState().insertIfAbsent(installs.key(installId), {
    secretDigest: digest(secret).toString('base64url'),
    provider: input.provider,
    sealed: await sealDirectoryCredentials(sealedPendingAs(input.provider), PENDING_TENANT, { credentials, app: created.app }),
    redirectUrl: input.redirectUrl,
    userId: input.userId,
  })
  await appState().set(outcomes.key(installId), { status: 'pending' })
  url.searchParams.set('state', `${installId}.${secret}`)
  url.searchParams.set('redirect_uri', input.redirectUrl)
  return { installId, url: url.toString() }
}

/** How an install the Settings page started went; `expired` once it can't finish any more. */
export async function directoryInstallOutcome(installId: string): Promise<DirectoryInstallStatus> {
  const outcome = (await appState().get(outcomes.key(installId)))?.value
  if (!outcome) return { status: 'expired' }
  if ((outcome.status === 'pending' || outcome.status === 'cancelled') && !(await appState().get(installs.key(installId)))) return { status: 'expired' }
  return outcome
}

/** The install a callback's `state` names, if its secret matches. */
async function pendingFor(state: string): Promise<{ installId: string; pending: PendingInstall } | null> {
  const [installId, secret, ...rest] = state.split('.')
  if (!installId || !secret || rest.length) return null
  const entry = await appState().get(installs.key(installId))
  if (!entry) return null
  const expected = Buffer.from(entry.value.secretDigest, 'base64url')
  const given = digest(secret)
  return expected.length === given.length && timingSafeEqual(expected, given) ? { installId, pending: entry.value } : null
}

/**
 * Finishes an install from the provider's callback: the directory is
 * connected with what the install gave. Null when `state` isn't an install
 * this host has waiting. The install is used up first, so a replayed callback
 * does nothing. A declined install stays, so the same page can be tried again
 * until it expires.
 */
export async function completeDirectoryAppConnect(input: { state: string; code?: string; error?: string }): Promise<DirectoryInstallStatus | null> {
  const found = await pendingFor(input.state)
  if (!found) return null
  if (input.error || !input.code) {
    const outcome = { status: 'cancelled' as const, at: Date.now() }
    await appState().set(outcomes.key(found.installId), outcome)
    return outcome
  }
  const consumed = await appState().consume(installs.key(found.installId))
  if (!consumed.consumed) return null
  let outcome: DirectoryInstallStatus
  try {
    outcome = await finishInstall(consumed.entry.value, input.code)
  } catch (error) {
    if (!(error instanceof DirectoryConnectError)) captureException(error, { tags: { component: 'team-directory', operation: 'install-directory-app' } })
    outcome = { status: 'failed', error: error instanceof DirectoryConnectError ? error.message : 'The directory could not be connected. Try again.' }
  }
  await appState().set(outcomes.key(found.installId), outcome)
  return outcome
}

async function openPending(pending: PendingInstall) {
  const provisioning = provisioningOf({ provider: pending.provider })
  if (!provisioning) throw new DirectoryConnectError('This version of the app can’t connect this directory.')
  const sealed = sealedPendingSchema.parse(await openDirectoryCredentials(sealedPendingAs(pending.provider), PENDING_TENANT, pending.sealed))
  const credentials = provisioning.credentialsSchema.parse(sealed.credentials)
  return { credentials, app: sealed.app, provisioning, provisioner: provisioning.open(credentials) }
}

async function finishInstall(pending: PendingInstall, code: string): Promise<DirectoryInstallStatus> {
  const provider = getDirectoryProvider(pending.provider)
  if (!provider) throw new DirectoryConnectError('This version of the app can’t connect this directory.')
  const { credentials, app, provisioning, provisioner } = await openPending(pending)
  if (!provisioning.directoryApp) throw new DirectoryConnectError('This version of the app can’t connect this directory.')
  let connection: DirectoryConnection
  let notices: string[]
  try {
    const directoryCredentials = provider.credentialsSchema.parse(await provisioning.directoryApp.completeInstall(credentials, app, code, pending.redirectUrl))
    const tenant = await provider.verify(directoryCredentials)
    connection = await saveDirectoryConnection({ provider: pending.provider, tenant, credentials: directoryCredentials, createdByUserId: pending.userId })
    notices = tenant.notices ?? []
  } catch (error) {
    background(deleteQuietly(provisioner, app, 'delete-failed-directory-app'), { name: 'team-directory.delete-failed-app' })
    throw error
  }
  // The directory works from here on, so this is reported as connected whatever comes next.
  try {
    const previous = await attachDirectoryApp(connection, credentials, app)
    if (previous) background(deleteQuietly(provisioner, previous, 'delete-replaced-directory-app'), { name: 'team-directory.delete-replaced-app' })
  } catch (error) {
    captureException(error, { tags: { component: 'team-directory', operation: 'attach-directory-app' }, extra: { directoryId: connection.id } })
    notices = [...notices, 'Agents’ apps couldn’t be set up with this token. Add it again under Agent apps.']
  }
  // List it now, so the first search finds it cached.
  background(listDirectoryNow(connection), { name: 'team-directory.first-listing' })
  await logAuditEvent({ userId: pending.userId, object: 'team_directory', objectId: connection.id, action: 'connected', details: { provider: pending.provider, tenantName: connection.tenantName, app: true } })
  return { status: 'connected', directoryId: connection.id, tenantName: connection.tenantName, notices }
}

/**
 * Stores the provisioning credentials and the new app on the directory, in
 * place of any app Gamut made for it before, which is returned for deleting.
 * A compare-and-set on the app: of two installs finishing at once, each
 * replaces exactly what it read.
 */
async function attachDirectoryApp(connection: DirectoryConnection, credentials: unknown, app: ProvisionedAppRecord): Promise<ProvisionedAppRecord | null> {
  const directoryApp = await sealDirectoryCredentials(sealedAppAs(connection.provider), connection.tenantId, app)
  for (let attempt = 0; attempt < 8; attempt++) {
    const replacing = (await db.select({ directoryApp: teamDirectories.directoryApp }).from(teamDirectories).where(eq(teamDirectories.id, connection.id)).get())?.directoryApp ?? null
    if (await saveProvisioningCredentials(connection, credentials, { directoryApp, replacing })) {
      if (!replacing) return null
      return openDirectoryCredentials(sealedAppAs(connection.provider), connection.tenantId, replacing).then((previous) => appRecordSchema.parse(previous), () => null)
    }
  }
  throw new Error('The directory changed concurrently')
}

/** Ends an install the admin started over: its app goes. False when it was already installed or gone. */
export async function abandonDirectoryInstall(installId: string): Promise<boolean> {
  const consumed = await appState().consume(installs.key(installId))
  if (!consumed.consumed) return false
  await appState().delete(outcomes.key(installId))
  try {
    const { provisioner, app } = await openPending(consumed.entry.value)
    await deleteQuietly(provisioner, app, 'delete-abandoned-directory-app')
  } catch (error) {
    captureException(error, { tags: { component: 'team-directory', operation: 'abandon-directory-install' } })
  }
  return true
}

export type DirectoryAppCleanup =
  /** Delete the app once the directory is gone. Nothing in it waits on the request. */
  | { kind: 'delete'; run(): Promise<void> }
  /** The app stays: there are no app-creation credentials left to delete it with. */
  | { kind: 'left-behind' }

/**
 * What disconnecting a directory must also undo: deleting the app Gamut made
 * for it. Read before the row goes; nothing here calls the provider. Null for
 * a directory whose app an admin made.
 */
export async function directoryAppCleanup(directoryId: string): Promise<DirectoryAppCleanup | null> {
  const row = await db.select({ provider: teamDirectories.provider, tenantId: teamDirectories.tenantId, directoryApp: teamDirectories.directoryApp })
    .from(teamDirectories).where(eq(teamDirectories.id, directoryId)).get()
  if (!row?.directoryApp) return null
  try {
    const app = appRecordSchema.parse(await openDirectoryCredentials(sealedAppAs(row.provider), row.tenantId, row.directoryApp))
    const loaded = await loadProvisioning(directoryId)
    if (!loaded || loaded.connection.provisioningStatus !== 'active') return { kind: 'left-behind' }
    const { provisioning, credentials } = loaded
    return {
      kind: 'delete',
      run: async () => {
        try {
          // The directory is gone, so nothing renews these any more: renew them here if they are due.
          const fresh = provisioning.rotate && provisioning.needsRotation?.(credentials, Date.now()) ? await provisioning.rotate(credentials) : credentials
          await provisioning.open(fresh).deleteApp(app)
        } catch (error) {
          captureException(error, { tags: { component: 'team-directory', operation: 'delete-directory-app' }, extra: { directoryId } })
        }
      },
    }
  } catch (error) {
    console.warn(`[TeamDirectory] The app of directory ${directoryId} stays: ${error instanceof Error ? error.message : String(error)}`)
    return { kind: 'left-behind' }
  }
}
