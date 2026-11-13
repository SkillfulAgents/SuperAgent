/**
 * Agents' own apps, created through a connected team directory (Slack first).
 * Everything here is the same for every provider: a provider only implements
 * `AgentIdentityProvisioning` (types.ts). See docs/team-directory.md.
 *
 * - Credentials: sealed on the directory's row, apart from its own. Rotated
 *   ahead of expiry, one rotation at a time per directory (an AppState lease),
 *   and the new pair is saved before it is used. A rotation that can't renew
 *   them marks the directory "needs reconnect": apps already installed keep
 *   working, only new ones wait for an admin.
 * - Apps: created when an installation is set up (agent-integrations/setup.ts),
 *   installed through the provider's OAuth page with a one-time state held in
 *   AppState, renamed or given a new icon from the integration page, and
 *   deleted with the installation.
 */
import { randomBytes } from 'node:crypto'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@shared/lib/db'
import { changesOf } from '@shared/lib/db/batch'
import { chatIntegrations, teamDirectories } from '@shared/lib/db/schema'
import { appState, defineLease, defineNamespace, digestKeyPart } from '@shared/lib/app-state'
import { captureException } from '@shared/lib/error-reporting'
import { IntegrationSetupError } from '@shared/lib/agent-integrations/setup-types'
import { provisionedAppConfigSchema, type ProvisionedAppConfig } from '@shared/lib/agent-integrations/provisioned-app'
import { openDirectoryCredentials, sealDirectoryCredentials } from './credentials'
import { getDirectoryProvider } from './registry'
import { getDirectoryConnection, listDirectoryConnections, type DirectoryConnection } from './store'
import {
  DirectoryConnectError,
  ProvisioningCredentialsError,
  type AgentAppIdentity,
  type AgentIdentityProvisioner,
  type AgentIdentityProvisioning,
} from './types'
import type { VerificationProfile } from '@shared/lib/services/webhook-endpoint-schema'

/** A rotation is one request with a 15 s timeout, plus the write after it. */
const ROTATE_REQUEST_MS = 15_000
const rotations = defineLease({ name: 'claim:team-directory-provisioning', ttlMs: 60_000 })
const INSTALL_STATE_TTL_MS = 30 * 60_000

/** The credentials are sealed as the provider's provisioning ones, so the directory's own never open as them. */
const sealedAs = (connection: Pick<DirectoryConnection, 'provider'>) => `${connection.provider}:provisioning`

/** A directory provider's app creation, if it has one. */
export function provisioningOf(connection: Pick<DirectoryConnection, 'provider'>): AgentIdentityProvisioning<unknown> | undefined {
  return getDirectoryProvider(connection.provider)?.provisioning as AgentIdentityProvisioning<unknown> | undefined
}

// ── Credentials ─────────────────────────────────────────────────────

/**
 * Stores verified provisioning credentials on a directory, over any it had.
 * `directoryApp` (sealed) comes along when the directory was connected with
 * them, written only over `replacing` (the sealed app read before, or null):
 * false when another write changed it meanwhile.
 */
export async function saveProvisioningCredentials(
  connection: Pick<DirectoryConnection, 'id' | 'provider' | 'tenantId'>,
  credentials: unknown,
  app?: { directoryApp: string; replacing: string | null },
): Promise<boolean> {
  return changesOf(await db.update(teamDirectories).set({
    provisioningCredentials: await sealDirectoryCredentials(sealedAs(connection), connection.tenantId, credentials),
    provisioningRevision: sql`${teamDirectories.provisioningRevision} + 1`,
    provisioningStatus: 'active',
    provisioningError: null,
    ...(app ? { directoryApp: app.directoryApp } : {}),
    updatedAt: new Date(),
  }).where(and(
    eq(teamDirectories.id, connection.id),
    ...(app ? [app.replacing === null ? isNull(teamDirectories.directoryApp) : eq(teamDirectories.directoryApp, app.replacing)] : []),
  )).run()) > 0
}

/** Verifies and stores an admin's provisioning credentials on a connected directory. */
export async function connectProvisioning(directoryId: string, input: unknown): Promise<DirectoryConnection> {
  const connection = await getDirectoryConnection(directoryId)
  if (!connection) throw new DirectoryConnectError('Directory not found')
  const provisioning = provisioningOf(connection)
  if (!provisioning) throw new DirectoryConnectError('This directory can’t create agents’ apps.')
  await saveProvisioningCredentials(connection, await provisioning.verify(provisioning.credentialsSchema.parse(input), connection))
  return (await getDirectoryConnection(directoryId))!
}

export async function disconnectProvisioning(directoryId: string): Promise<boolean> {
  return changesOf(await db.update(teamDirectories).set({
    provisioningCredentials: null,
    provisioningRevision: sql`${teamDirectories.provisioningRevision} + 1`,
    provisioningStatus: null,
    provisioningError: null,
    updatedAt: new Date(),
  }).where(eq(teamDirectories.id, directoryId)).run()) > 0
}

export interface LoadedProvisioning {
  connection: DirectoryConnection
  provisioning: AgentIdentityProvisioning<unknown>
  credentials: unknown
  revision: number
}

/** A directory's provisioning credentials as stored, not rotated; null when it has none. */
export async function loadProvisioning(directoryId: string): Promise<LoadedProvisioning | null> {
  const row = await db.select().from(teamDirectories).where(eq(teamDirectories.id, directoryId)).get()
  if (!row?.provisioningCredentials) return null
  const provisioning = provisioningOf(row)
  if (!provisioning) return null
  const { credentials: _directory, provisioningCredentials, directoryApp: _app, ...connection } = row
  const credentials = provisioning.credentialsSchema.parse(await openDirectoryCredentials(sealedAs(row), row.tenantId, provisioningCredentials))
  return { connection, provisioning, credentials, revision: row.provisioningRevision }
}

/** Saves what a rotation produced, only over the pair it rotated: a pair an admin added since stands. */
async function saveRotated(loaded: LoadedProvisioning, credentials: unknown): Promise<boolean> {
  return changesOf(await db.update(teamDirectories).set({
    provisioningCredentials: await sealDirectoryCredentials(sealedAs(loaded.connection), loaded.connection.tenantId, credentials),
    provisioningRevision: sql`${teamDirectories.provisioningRevision} + 1`,
    provisioningStatus: 'active',
    provisioningError: null,
    updatedAt: new Date(),
  }).where(and(eq(teamDirectories.id, loaded.connection.id), eq(teamDirectories.provisioningRevision, loaded.revision))).run()) > 0
}

async function markNeedsReconnect(loaded: LoadedProvisioning, message: string): Promise<void> {
  await db.update(teamDirectories).set({ provisioningStatus: 'needs_reconnect', provisioningError: message, updatedAt: new Date() })
    .where(and(eq(teamDirectories.id, loaded.connection.id), eq(teamDirectories.provisioningRevision, loaded.revision))).run()
}

export type RotationOutcome = 'rotated' | 'fresh' | 'broken' | 'failed' | 'none'

/**
 * Rotates a directory's provisioning credentials when they are due (or always,
 * with `force`). One rotation at a time per directory: a provider's rotation
 * may retire the old pair, so two at once would break the chain.
 */
export async function rotateProvisioning(directoryId: string, options: { force?: boolean } = {}): Promise<RotationOutcome> {
  const first = await loadProvisioning(directoryId)
  if (!first?.provisioning.rotate || first.connection.provisioningStatus !== 'active') return 'none'
  const turn = await rotations.acquireWhenFree(rotations.key(directoryId), { timeoutMs: rotations.ttlMs + ROTATE_REQUEST_MS })
  if (!turn.acquired) return 'none'
  return rotations.hold(turn.lease, async (holding) => {
    // Decide from what is stored now: the holder before may have just rotated.
    const loaded = await loadProvisioning(directoryId)
    if (!loaded?.provisioning.rotate || loaded.connection.provisioningStatus !== 'active') return 'none'
    if (!options.force && !loaded.provisioning.needsRotation?.(loaded.credentials, Date.now())) return 'fresh'
    let rotated: unknown
    try {
      await holding.confirm({ minRemainingMs: ROTATE_REQUEST_MS })
      rotated = await loaded.provisioning.rotate(loaded.credentials)
    } catch (error) {
      if (error instanceof ProvisioningCredentialsError) {
        await markNeedsReconnect(loaded, error.message)
        console.warn(`[TeamDirectory] Provisioning credentials of directory ${directoryId} need replacing: ${error.message}`)
        return 'broken'
      }
      // A network failure or rate limit: the stored pair is still good, the next pass tries again.
      console.warn(`[TeamDirectory] Rotating provisioning credentials of directory ${directoryId} failed:`, error instanceof Error ? error.message : error)
      return 'failed'
    }
    // The old pair may be retired already: save the new one before anything uses it.
    if (!(await saveRotated(loaded, rotated))) {
      captureException(new Error('Rotated provisioning credentials were not saved: the stored pair changed meanwhile'), {
        tags: { component: 'team-directory', operation: 'rotate-provisioning' }, extra: { directoryId },
      })
      return 'failed'
    }
    return 'rotated'
  })
}

/** The background pass: every directory with provisioning credentials, rotated when due. */
export async function rotateAllProvisioning(): Promise<void> {
  for (const connection of await listDirectoryConnections()) {
    if (connection.provisioningStatus !== 'active') continue
    try {
      await rotateProvisioning(connection.id)
    } catch (error) {
      captureException(error, { tags: { component: 'team-directory', operation: 'rotate-provisioning' }, extra: { directoryId: connection.id } })
    }
  }
}

/** The provisioner of a directory, with credentials rotated first when they are due. */
export async function provisionerFor(directoryId: string): Promise<{ provisioner: AgentIdentityProvisioner; connection: DirectoryConnection }> {
  let loaded = await loadProvisioning(directoryId)
  if (loaded?.provisioning.needsRotation?.(loaded.credentials, Date.now())) {
    await rotateProvisioning(directoryId)
    loaded = await loadProvisioning(directoryId)
  }
  if (!loaded) throw new IntegrationSetupError('The team directory that created this app can’t manage it any more. Ask an admin to check Settings → Team Directory.')
  if (loaded.connection.provisioningStatus !== 'active') {
    throw new IntegrationSetupError(`The ${loaded.connection.tenantName} directory can’t create or change apps until an admin adds a new token for it under Settings → Team Directory → Agent apps.`)
  }
  return { provisioner: loaded.provisioning.open(loaded.credentials), connection: loaded.connection }
}

// ── Finding a provisioner ───────────────────────────────────────────

export interface ProvisioningOffer {
  directoryId: string
  /** The workspace the app is created in. */
  workspace: string
}

/** A connected directory that can create apps for `integrationProvider` now. Any agent owner may use it. */
export async function findProvisioner(integrationProvider: string): Promise<ProvisioningOffer | null> {
  for (const connection of await listDirectoryConnections()) {
    if (connection.provisioningStatus !== 'active') continue
    if (provisioningOf(connection)?.integrationProvider !== integrationProvider) continue
    return { directoryId: connection.id, workspace: connection.tenantName }
  }
  return null
}

// ── Apps ────────────────────────────────────────────────────────────

/**
 * Creates an installation's app, once its webhook URL exists. Returns the
 * config to store (the provider's fields and `provisionedApp`) and the relay's
 * signature check.
 */
export async function createAgentApp(input: {
  directoryId: string
  integrationProvider: string
  identity: AgentAppIdentity
  webhookUrl: string
  redirectUrl: string
}): Promise<{ config: Record<string, unknown>; verification?: VerificationProfile; release(): Promise<void> }> {
  const { provisioner, connection } = await provisionerFor(input.directoryId)
  if (provisioningOf(connection)?.integrationProvider !== input.integrationProvider) {
    throw new IntegrationSetupError('This directory can’t create apps for this add-on.')
  }
  const created = await provisioner.createApp({ ...input.identity, webhookUrl: input.webhookUrl, redirectUrl: input.redirectUrl })
  const provisionedApp: ProvisionedAppConfig = provisionedAppConfigSchema.parse({
    directoryId: input.directoryId,
    app: created.app,
    installUrl: created.installUrl,
    installed: false,
    name: input.identity.name,
    iconSet: created.iconSet,
    ...(created.settingsUrl ? { settingsUrl: created.settingsUrl } : {}),
  })
  return {
    config: { ...created.config, provisionedApp },
    ...(created.verification ? { verification: created.verification } : {}),
    // The installation was not created after all: the app goes too.
    release: () => deleteAgentApp(provisionedApp),
  }
}

/** Deletes an app the directory created. Best effort: a provider that can't be reached must not keep the installation. */
export async function deleteAgentApp(provisionedApp: ProvisionedAppConfig): Promise<void> {
  try {
    const { provisioner } = await provisionerFor(provisionedApp.directoryId)
    await provisioner.deleteApp(provisionedApp.app)
  } catch (error) {
    captureException(error, { tags: { component: 'team-directory', operation: 'delete-agent-app' }, extra: { directoryId: provisionedApp.directoryId } })
  }
}

/** The provisioned app in an installation's stored config, if it has one. */
export function provisionedAppOf(configJson: string): ProvisionedAppConfig | null {
  try {
    const parsed = provisionedAppConfigSchema.safeParse((JSON.parse(configJson) as { provisionedApp?: unknown }).provisionedApp)
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/**
 * Rewrites an installation's config from the one read, as the host: the
 * provider's own merge refuses host-owned fields. Retries from the current row
 * when another write landed in between.
 */
async function rewriteIntegrationConfig(
  integrationId: string,
  change: (config: Record<string, unknown>) => Record<string, unknown>,
  columns: { status?: 'active'; errorMessage?: null } = {},
): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const row = await db.select({ config: chatIntegrations.config }).from(chatIntegrations).where(eq(chatIntegrations.id, integrationId)).get()
    if (!row) throw new IntegrationSetupError('This add-on was deleted.', 404)
    const next = change(z.record(z.string(), z.unknown()).parse(JSON.parse(row.config)))
    const written = changesOf(await db.update(chatIntegrations)
      .set({ config: JSON.stringify(next), ...columns, updatedAt: new Date() })
      .where(and(eq(chatIntegrations.id, integrationId), eq(chatIntegrations.config, row.config))).run())
    if (written) return
  }
  throw new Error('The integration changed concurrently; try again')
}

const installStates = defineNamespace({
  name: 'oauth:agent-app-install',
  consistency: 'strong',
  schema: z.object({ integrationId: z.string(), provider: z.string(), redirectUrl: z.string().url() }),
  expiry: { ttlMs: INSTALL_STATE_TTL_MS, onUpdate: 'keep' },
})

/** The provider page that installs an installation's app, with a one-time state for its callback. */
export async function startAgentAppInstall(integration: { id: string; provider: string; config: string }, redirectUrl: string): Promise<{ url: string }> {
  const provisioned = provisionedAppOf(integration.config)
  if (!provisioned) throw new IntegrationSetupError('This add-on’s app wasn’t created by Gamut.')
  const state = randomBytes(24).toString('base64url')
  await appState().insertIfAbsent(installStates.key(digestKeyPart(state)), { integrationId: integration.id, provider: integration.provider, redirectUrl })
  const url = new URL(provisioned.installUrl)
  url.searchParams.set('state', state)
  url.searchParams.set('redirect_uri', redirectUrl)
  return { url: url.toString() }
}

/** As a provider's own setup callback answers. */
export type InstallCallbackResult = { integrationId?: string; cancelled?: boolean; redirectUrl?: string }

/**
 * Finishes an install from the provider's callback. Null when `state` isn't an
 * install this host started (the provider's own callback, if any, handles it).
 * The state is used up first, so a callback replayed does nothing.
 */
export async function completeAgentAppInstall(provider: string, input: { state: string; code?: string; error?: string }): Promise<InstallCallbackResult | null> {
  const consumed = await appState().consume(installStates.key(digestKeyPart(input.state)))
  if (!consumed.consumed) return null
  const { integrationId, redirectUrl } = consumed.entry.value
  if (consumed.entry.value.provider !== provider) throw new IntegrationSetupError('This install belongs to another add-on.')
  if (input.error || !input.code) return { cancelled: true }
  const row = await db.select({ config: chatIntegrations.config }).from(chatIntegrations).where(eq(chatIntegrations.id, integrationId)).get()
  const provisioned = row && provisionedAppOf(row.config)
  if (!provisioned) throw new IntegrationSetupError('This add-on was deleted.', 404)
  const { provisioner } = await provisionerFor(provisioned.directoryId)
  const connected = await provisioner.completeInstall(provisioned.app, input.code, redirectUrl)
  await rewriteIntegrationConfig(integrationId, (config) => ({
    ...config,
    ...connected,
    provisionedApp: { ...provisionedAppConfigSchema.parse(config.provisionedApp), installed: true },
  }), { status: 'active', errorMessage: null })
  return { integrationId }
}

/** Renames an installation's app and gives it a new icon; what is absent stays. */
export async function updateAgentApp(integrationId: string, configJson: string, input: Partial<Pick<AgentAppIdentity, 'name' | 'icon'>>): Promise<void> {
  const provisioned = provisionedAppOf(configJson)
  if (!provisioned) throw new IntegrationSetupError('This app wasn’t created by Gamut, so it can only be renamed in its provider’s settings.')
  const { provisioner } = await provisionerFor(provisioned.directoryId)
  const name = input.name?.trim()
  const { iconSet } = await provisioner.updateApp(provisioned.app, { ...(name ? { name } : {}), ...(input.icon ? { icon: input.icon } : {}) })
  if (input.icon && iconSet === false) throw new IntegrationSetupError('The icon was not set. Try again in a minute.')
  await rewriteIntegrationConfig(integrationId, (config) => {
    const current = provisionedAppConfigSchema.parse(config.provisionedApp)
    return { ...config, provisionedApp: { ...current, ...(name ? { name } : {}), ...(iconSet ? { iconSet: true } : {}) } }
  })
}
