/**
 * Settings → Team directory (admins only): connect a workspace directory with
 * a token, check it, disconnect it. The providers describe their own connect
 * forms, so nothing here knows which provider it is handling.
 */
import { Hono, type Context } from 'hono'
import { html } from 'hono/html'
import { z } from 'zod'
import { inArray } from 'drizzle-orm'
import { Authenticated, IsAdmin } from '../middleware/auth'
import { db } from '@shared/lib/db'
import { user } from '@shared/lib/db/schema'
import { isAuthMode } from '@shared/lib/auth/mode'
import { getCurrentUserId } from '@shared/lib/auth/config'
import { background } from '@shared/lib/background'
import { logAuditEvent } from '@shared/lib/services/audit-log-service'
import { forgetDirectoryUsers, listDirectoryNow } from '@shared/lib/team-directory/cache'
import { getDirectoryProvider, listDirectoryProviders } from '@shared/lib/team-directory/registry'
import {
  deleteDirectoryConnection,
  getDirectoryConnection,
  listDirectoryConnections,
  saveDirectoryConnection,
  type DirectoryConnection,
} from '@shared/lib/team-directory/store'
import { DirectoryConnectError, type DirectoryTenant } from '@shared/lib/team-directory/types'
import type {
  DirectoryInstallStatus, DirectoryProviderView, DisconnectDirectoryResponse, StartDirectoryInstallResponse, TeamDirectoryView,
} from '@shared/lib/team-directory/view-schema'
import { connectProvisioning, disconnectProvisioning } from '@shared/lib/team-directory/provisioning'
import {
  abandonDirectoryInstall,
  completeDirectoryAppConnect,
  connectsWithProvisioning,
  directoryAppCleanup,
  directoryInstallOutcome,
  startDirectoryAppConnect,
} from '@shared/lib/team-directory/directory-app'
import { resolvePublicAppBaseUrl } from '@shared/lib/agent-integrations/app-link'
import { captureException } from '@shared/lib/error-reporting'
import { trackServerEvent } from '@shared/lib/analytics/server-analytics'

const router = new Hono()

const CALLBACK_PATH = '/api/team-directories/install/callback'

/** Where the provider's install page returns: this app's public URL. */
async function callbackUrl(c: Context): Promise<string | null> {
  const baseUrl = await resolvePublicAppBaseUrl(c.req.raw)
  return baseUrl ? `${baseUrl}${CALLBACK_PATH}` : null
}

const callbackPage = (title: string, message: string, status: 200 | 400 = 200) => (c: Context) => {
  c.header('Cache-Control', 'no-store'); c.header('Referrer-Policy', 'no-referrer')
  return c.html(html`<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1><p>${message}</p></body></html>`, status)
}

// GET /api/team-directories/install/callback - Where the provider's install page
// returns. Before the admin check: the browser may not hold the admin's
// session (the desktop app opens the system browser); the one-time state is
// what identifies the install.
router.get('/install/callback', async (c) => {
  const state = c.req.query('state')
  if (!state) return callbackPage('Install unavailable', 'Return to Gamut to try again.', 400)(c)
  try {
    const outcome = await completeDirectoryAppConnect({ state, code: c.req.query('code'), error: c.req.query('error') })
    if (!outcome) return callbackPage('Install expired', 'Return to Gamut and start again.', 400)(c)
    if (outcome.status === 'connected') {
      trackServerEvent('team_directory_connected', { method: 'install' })
      return callbackPage(`${outcome.tenantName} connected`, 'You can close this window and return to Gamut.')(c)
    }
    if (outcome.status === 'failed') {
      trackServerEvent('team_directory_connect_failed', { method: 'install' })
      return callbackPage('Could not connect', `${outcome.error} Return to Gamut to try again.`, 400)(c)
    }
    return callbackPage('Install cancelled', 'Return to Gamut to try again.', 400)(c)
  } catch (error) {
    captureException(error, { tags: { component: 'team-directory', operation: 'install-callback' } })
    return callbackPage('Could not connect', 'Return to Gamut to try again.', 400)(c)
  }
})

router.use('*', Authenticated(), IsAdmin())

const connectBodySchema = z.object({
  provider: z.string().min(1),
  credentials: z.record(z.string(), z.unknown()),
})

class RequestError extends Error {}

router.onError((error, c) => {
  if (error instanceof DirectoryConnectError || error instanceof RequestError) return c.json({ error: error.message }, 400)
  if (error instanceof z.ZodError) return c.json({ error: error.issues[0]?.message ?? 'Invalid request' }, 400)
  console.error('[TeamDirectory] Request failed:', error)
  return c.json({ error: 'Something went wrong with the team directory' }, 500)
})

async function views(connections: DirectoryConnection[]): Promise<TeamDirectoryView[]> {
  const creatorIds = [...new Set(connections.map((c) => c.createdByUserId).filter((id): id is string => !!id))]
  const creators = creatorIds.length
    ? new Map((await db.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, creatorIds)).all()).map((row) => [row.id, row.name]))
    : new Map<string, string>()
  return connections.map((connection) => {
    const provider = getDirectoryProvider(connection.provider)
    return {
      id: connection.id,
      provider: connection.provider,
      providerLabel: provider?.info.label ?? connection.provider,
      tenantName: connection.tenantName,
      status: provider ? connection.status : 'error',
      errorMessage: provider ? connection.errorMessage : 'This version of the app cannot read this directory.',
      connectedBy: connection.createdByUserId ? creators.get(connection.createdByUserId) ?? null : null,
      connectedAt: connection.createdAt.getTime(),
      ...(provider?.provisioning ? { provisioning: { status: connection.provisioningStatus, error: connection.provisioningError } } : {}),
    }
  })
}

/** Parses a connect form against its provider and verifies it with the provider. */
async function verified(body: unknown): Promise<{ provider: string; credentials: unknown; tenant: DirectoryTenant }> {
  const input = connectBodySchema.parse(body)
  const provider = getDirectoryProvider(input.provider)
  if (!provider) throw new RequestError(`Unknown directory provider: ${input.provider}`)
  const credentials = provider.credentialsSchema.parse(input.credentials)
  return { provider: input.provider, credentials, tenant: await provider.verify(credentials) }
}

// GET /api/team-directories - The providers this build offers, and the connected directories.
router.get('/', async (c) => {
  c.header('Cache-Control', 'no-store')
  const callback = await callbackUrl(c)
  return c.json({
    providers: listDirectoryProviders().map((provider): DirectoryProviderView => ({
      ...provider.info,
      ...(provider.provisioning
        ? { provisioning: { ...provider.provisioning.info, ...(connectsWithProvisioning(provider, callback) ? { connectsDirectory: true } : {}) } }
        : {}),
    })),
    directories: await views(await listDirectoryConnections()),
  })
})

// POST /api/team-directories/test - Checks credentials without saving them.
router.post('/test', async (c) => {
  const { tenant } = await verified(await c.req.json())
  return c.json({ tenantName: tenant.tenantName, notices: tenant.notices ?? [] })
})

// POST /api/team-directories - Connects a directory (or replaces the credentials of one already connected).
router.post('/', async (c) => {
  const body = await c.req.json()
  const { provider, credentials, tenant } = await verified(body).catch((error) => {
    // The provider refused the credentials; a malformed form is not a connect attempt.
    if (error instanceof DirectoryConnectError) trackServerEvent('team_directory_connect_failed', { method: 'token' })
    throw error
  })
  const saved = await saveDirectoryConnection({
    provider,
    tenant,
    credentials,
    createdByUserId: isAuthMode() ? getCurrentUserId(c) : null,
  })
  // List it now, so the first search finds it cached.
  background(listDirectoryNow(saved), { name: 'team-directory.first-listing' })
  await logAuditEvent({ userId: isAuthMode() ? getCurrentUserId(c) : null, object: 'team_directory', objectId: saved.id, action: 'connected', details: { provider, tenantName: tenant.tenantName } })
  // The provider's id only: a tenant name names a company.
  trackServerEvent('team_directory_connected', { method: 'token', directory_provider: provider })
  const [view] = await views([saved])
  return c.json({ directory: view, notices: tenant.notices ?? [] }, 201)
})

// POST /api/team-directories/install - Connects a directory with its provider's
// app-creation credentials alone: creates the directory's app and returns the
// page that installs it. The install's callback connects the directory.
router.post('/install', async (c) => {
  const input = connectBodySchema.parse(await c.req.json())
  const redirectUrl = await callbackUrl(c)
  if (!redirectUrl) throw new RequestError('This app has no public URL for the install to return to.')
  const started = await startDirectoryAppConnect({
    provider: input.provider,
    credentials: input.credentials,
    redirectUrl,
    userId: isAuthMode() ? getCurrentUserId(c) : null,
  })
  return c.json(started satisfies StartDirectoryInstallResponse)
})

// GET /api/team-directories/install/:installId - How an install started here went.
router.get('/install/:installId', async (c) => {
  c.header('Cache-Control', 'no-store')
  return c.json((await directoryInstallOutcome(c.req.param('installId'))) satisfies DirectoryInstallStatus)
})

// DELETE /api/team-directories/install/:installId - Abandons an install (Start over): its app is deleted.
router.delete('/install/:installId', async (c) => {
  await abandonDirectoryInstall(c.req.param('installId'))
  return c.body(null, 204)
})

// POST /api/team-directories/:id/refresh - Lists the directory now: how many people it has, or why it can't be read.
router.post('/:id/refresh', async (c) => {
  const connection = await getDirectoryConnection(c.req.param('id'))
  if (!connection) return c.json({ error: 'Directory not found' }, 404)
  const result = await listDirectoryNow(connection)
  const [view] = await views([(await getDirectoryConnection(connection.id)) ?? connection])
  return c.json(result.ok ? { ok: true, userCount: result.users.length, directory: view } : { ok: false, error: result.error, directory: view })
})

// POST /api/team-directories/:id/provisioning - Adds (or replaces) the credentials
// that let the directory create agents' own apps, verified first.
router.post('/:id/provisioning', async (c) => {
  const input = z.object({ credentials: z.record(z.string(), z.unknown()) }).parse(await c.req.json())
  if (!(await getDirectoryConnection(c.req.param('id')))) return c.json({ error: 'Directory not found' }, 404)
  const saved = await connectProvisioning(c.req.param('id'), input.credentials)
  await logAuditEvent({ userId: isAuthMode() ? getCurrentUserId(c) : null, object: 'team_directory', objectId: saved.id, action: 'connected', details: { provisioning: true } })
  const [view] = await views([saved])
  return c.json({ directory: view })
})

// DELETE /api/team-directories/:id/provisioning - Stops creating apps through it. Apps already installed keep working.
router.delete('/:id/provisioning', async (c) => {
  if (!(await disconnectProvisioning(c.req.param('id')))) return c.json({ error: 'Directory not found' }, 404)
  await logAuditEvent({ userId: isAuthMode() ? getCurrentUserId(c) : null, object: 'team_directory', objectId: c.req.param('id'), action: 'disconnected', details: { provisioning: true } })
  return c.body(null, 204)
})

// DELETE /api/team-directories/:id - Disconnects a directory. Its people stop
// appearing in searches at once, and the app Gamut made for it is deleted
// after the response, or reported as left behind when it can't be.
router.delete('/:id', async (c) => {
  if (!(await getDirectoryConnection(c.req.param('id')))) return c.json({ error: 'Directory not found' }, 404)
  const cleanup = await directoryAppCleanup(c.req.param('id'))
  const removed = await deleteDirectoryConnection(c.req.param('id'))
  if (!removed) return c.json({ error: 'Directory not found' }, 404)
  if (cleanup?.kind === 'delete') background(cleanup.run(), { name: 'team-directory.delete-app' })
  await forgetDirectoryUsers(removed)
  await logAuditEvent({ userId: isAuthMode() ? getCurrentUserId(c) : null, object: 'team_directory', objectId: removed.id, action: 'disconnected', details: { provider: removed.provider, tenantName: removed.tenantName } })
  trackServerEvent('team_directory_disconnected', { directory_provider: removed.provider })
  return c.json({ appLeftBehind: cleanup?.kind === 'left-behind' } satisfies DisconnectDirectoryResponse)
})

export default router
