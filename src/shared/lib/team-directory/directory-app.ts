/**
 * Connecting a directory with its provisioning credentials alone (Slack: the
 * refresh token of an app configuration token). The host creates the
 * directory's own app with them, a person installs it in one click on the
 * provider's page, and the install gives the directory's credentials. The
 * provisioning credentials stay on the directory for agents' apps, and the app
 * is deleted with the directory. The same for every provider whose
 * provisioning has `createDirectoryApp`; see docs/team-directory.md.
 */
import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@shared/lib/db'
import { teamDirectories } from '@shared/lib/db/schema'
import { appState, defineNamespace, digestKeyPart } from '@shared/lib/app-state'
import { background } from '@shared/lib/background'
import { captureException } from '@shared/lib/error-reporting'
import { logAuditEvent } from '@shared/lib/services/audit-log-service'
import { listDirectoryNow } from './cache'
import { openDirectoryCredentials, sealDirectoryCredentials } from './credentials'
import { provisionerFor, saveProvisioningCredentials } from './provisioning'
import { getDirectoryProvider } from './registry'
import { saveDirectoryConnection, type DirectoryConnection } from './store'
import {
  DirectoryConnectError,
  type AgentIdentityProvisioner,
  type AgentIdentityProvisioning,
  type ProvisionedAppRecord,
  type TeamDirectoryProvider,
} from './types'

const INSTALL_TTL_MS = 30 * 60_000
/** What a pending install is sealed for, until its workspace is known. */
const PENDING_TENANT = 'pending-install'

const appRecordSchema = z.record(z.string(), z.unknown())
const sealedPendingSchema = z.object({ credentials: z.unknown(), app: appRecordSchema })

/** An install the host started, until the provider's page calls back. */
const installs = defineNamespace({
  name: 'oauth:directory-app-install',
  consistency: 'strong',
  schema: z.object({
    installId: z.string(),
    provider: z.string(),
    /** `{ credentials, app }` sealed: the provisioning credentials, rotated already, and the app made with them. */
    sealed: z.string(),
    redirectUrl: z.string().url(),
    userId: z.string().nullable(),
  }),
  expiry: { ttlMs: INSTALL_TTL_MS, onUpdate: 'keep' },
})

export const directoryInstallOutcomeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending') }),
  z.object({ status: z.literal('connected'), directoryId: z.string(), tenantName: z.string(), notices: z.array(z.string()) }),
  /** `at` tells one cancel from the next: the install can be tried again. */
  z.object({ status: z.literal('cancelled'), at: z.number() }),
  z.object({ status: z.literal('failed'), error: z.string() }),
])
export type DirectoryInstallOutcome = z.infer<typeof directoryInstallOutcomeSchema> | { status: 'expired' }

/** How an install went, for the Settings page that started it. */
const outcomes = defineNamespace({
  name: 'oauth:directory-app-install-outcome',
  consistency: 'strong',
  schema: directoryInstallOutcomeSchema,
  expiry: { ttlMs: INSTALL_TTL_MS, onUpdate: 'reset' },
})

const sealedPendingAs = (provider: string) => `${provider}:directory-app-install`
const sealedAppAs = (provider: string) => `${provider}:directory-app`

function provisioningOf(provider: TeamDirectoryProvider<unknown> | undefined): AgentIdentityProvisioning<unknown> | undefined {
  return provider?.provisioning as AgentIdentityProvisioning<unknown> | undefined
}

/** Whether a provider's directory can be connected with its provisioning credentials alone. */
export function connectsWithProvisioning(provider: TeamDirectoryProvider<unknown>): boolean {
  return !!provisioningOf(provider)?.createDirectoryApp
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
  const provisioning = provisioningOf(provider)
  if (!provider || !provisioning?.createDirectoryApp) throw new DirectoryConnectError(`${provider?.info.label ?? input.provider} can’t be connected with a token alone.`)
  const credentials = await provisioning.verify(provisioning.credentialsSchema.parse(input.credentials))
  // The pasted credentials may be retired by now (a rotation): a failure from here on needs new ones.
  let created
  let url: URL
  try {
    created = await provisioning.createDirectoryApp(credentials, { redirectUrl: input.redirectUrl })
    const parsed = URL.parse(created.installUrl)
    if (!parsed) throw new Error(`The provider returned an install URL that does not parse: ${created.installUrl}`)
    url = parsed
  } catch (error) {
    if (error instanceof DirectoryConnectError) throw error
    captureException(error, { tags: { component: 'team-directory', operation: 'create-directory-app' } })
    throw new DirectoryConnectError(`${provider.info.label} did not create the app. Generate a new token and try again.`)
  }
  const installId = randomBytes(18).toString('base64url')
  const state = randomBytes(24).toString('base64url')
  await appState().insertIfAbsent(installs.key(digestKeyPart(state)), {
    installId,
    provider: input.provider,
    sealed: await sealDirectoryCredentials(sealedPendingAs(input.provider), PENDING_TENANT, { credentials, app: created.app }),
    redirectUrl: input.redirectUrl,
    userId: input.userId,
  })
  await appState().set(outcomes.key(installId), { status: 'pending' })
  url.searchParams.set('state', state)
  url.searchParams.set('redirect_uri', input.redirectUrl)
  return { installId, url: url.toString() }
}

/** How an install the Settings page started went; `expired` once nothing is known of it. */
export async function directoryInstallOutcome(installId: string): Promise<DirectoryInstallOutcome> {
  return (await appState().get(outcomes.key(installId)))?.value ?? { status: 'expired' }
}

async function deleteQuietly(provisioner: AgentIdentityProvisioner, app: ProvisionedAppRecord, operation: string): Promise<void> {
  try {
    await provisioner.deleteApp(app)
  } catch (error) {
    captureException(error, { tags: { component: 'team-directory', operation } })
  }
}

/**
 * Finishes an install from the provider's callback: the directory is
 * connected with what the install gave. Null when `state` isn't an install
 * this host started. The state is used up first, so a replayed callback does
 * nothing. A declined install leaves it, so the same page can be tried again
 * until it expires.
 */
export async function completeDirectoryAppConnect(input: { state: string; code?: string; error?: string }): Promise<DirectoryInstallOutcome | null> {
  const key = installs.key(digestKeyPart(input.state))
  if (input.error || !input.code) {
    const waiting = await appState().get(key)
    if (!waiting) return null
    const outcome = { status: 'cancelled' as const, at: Date.now() }
    await appState().set(outcomes.key(waiting.value.installId), outcome)
    return outcome
  }
  const consumed = await appState().consume(key)
  if (!consumed.consumed) return null
  const pending = consumed.entry.value
  let outcome: DirectoryInstallOutcome
  try {
    outcome = await finishInstall(pending, input.code)
  } catch (error) {
    if (!(error instanceof DirectoryConnectError)) captureException(error, { tags: { component: 'team-directory', operation: 'install-directory-app' } })
    outcome = { status: 'failed', error: error instanceof DirectoryConnectError ? error.message : 'The directory could not be connected. Try again.' }
  }
  await appState().set(outcomes.key(pending.installId), outcome)
  return outcome
}

async function finishInstall(pending: z.infer<typeof installs.schema>, code: string): Promise<DirectoryInstallOutcome> {
  const provider = getDirectoryProvider(pending.provider)
  const provisioning = provisioningOf(provider)
  if (!provider || !provisioning) throw new DirectoryConnectError('This version of the app can’t connect this directory.')
  const sealed = sealedPendingSchema.parse(await openDirectoryCredentials(sealedPendingAs(pending.provider), PENDING_TENANT, pending.sealed))
  const credentials = provisioning.credentialsSchema.parse(sealed.credentials)
  const provisioner = provisioning.open(credentials)
  let connection: DirectoryConnection
  let notices: string[]
  try {
    const directoryCredentials = provider.credentialsSchema.parse(await provisioner.completeInstall(sealed.app, code, pending.redirectUrl))
    const tenant = await provider.verify(directoryCredentials)
    connection = await saveDirectoryConnection({ provider: pending.provider, tenant, credentials: directoryCredentials, createdByUserId: pending.userId })
    notices = tenant.notices ?? []
  } catch (error) {
    background(deleteQuietly(provisioner, sealed.app, 'delete-failed-directory-app'), { name: 'team-directory.delete-failed-app' })
    throw error
  }
  // A workspace connected before keeps its row: an app Gamut made for it then goes.
  const before = await db.select({ directoryApp: teamDirectories.directoryApp }).from(teamDirectories).where(eq(teamDirectories.id, connection.id)).get()
  const previous = before?.directoryApp
    ? await openDirectoryCredentials(sealedAppAs(connection.provider), connection.tenantId, before.directoryApp).then((app) => appRecordSchema.parse(app), () => null)
    : null
  await saveProvisioningCredentials(connection, credentials, {
    directoryApp: await sealDirectoryCredentials(sealedAppAs(connection.provider), connection.tenantId, sealed.app),
  })
  if (previous) background(deleteQuietly(provisioner, previous, 'delete-replaced-directory-app'), { name: 'team-directory.delete-replaced-app' })
  // List it now, so the first search finds it cached.
  background(listDirectoryNow(connection), { name: 'team-directory.first-listing' })
  await logAuditEvent({ userId: pending.userId, object: 'team_directory', objectId: connection.id, action: 'connected', details: { provider: pending.provider, tenantName: connection.tenantName, app: true } })
  return { status: 'connected', directoryId: connection.id, tenantName: connection.tenantName, notices }
}

/**
 * What disconnecting a directory must also undo: deleting the app Gamut made
 * for it. Read before the row goes, run after; null when there is nothing to
 * do or it can't be done (an app made by hand, credentials that no longer renew).
 */
export async function directoryAppCleanup(directoryId: string): Promise<(() => Promise<void>) | null> {
  const row = await db.select({ provider: teamDirectories.provider, tenantId: teamDirectories.tenantId, directoryApp: teamDirectories.directoryApp })
    .from(teamDirectories).where(eq(teamDirectories.id, directoryId)).get()
  if (!row?.directoryApp) return null
  try {
    const app = appRecordSchema.parse(await openDirectoryCredentials(sealedAppAs(row.provider), row.tenantId, row.directoryApp))
    const { provisioner } = await provisionerFor(directoryId)
    return () => deleteQuietly(provisioner, app, 'delete-directory-app')
  } catch (error) {
    console.warn(`[TeamDirectory] The app of directory ${directoryId} stays: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}
