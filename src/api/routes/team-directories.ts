/**
 * Settings → Team directory (admins only): connect a workspace directory with
 * a token, check it, disconnect it. The providers describe their own connect
 * forms, so nothing here knows which provider it is handling.
 */
import { Hono } from 'hono'
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
import type { TeamDirectoryView } from '@shared/lib/team-directory/view-schema'

const router = new Hono()
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
  return c.json({
    providers: listDirectoryProviders().map((provider) => provider.info),
    directories: await views(await listDirectoryConnections()),
  })
})

// POST /api/team-directories/test - Checks credentials without saving them.
router.post('/test', async (c) => {
  const { tenant } = await verified(await c.req.json())
  return c.json({ tenantName: tenant.tenantName })
})

// POST /api/team-directories - Connects a directory (or replaces the credentials of one already connected).
router.post('/', async (c) => {
  const { provider, credentials, tenant } = await verified(await c.req.json())
  const saved = await saveDirectoryConnection({
    provider,
    tenant,
    credentials,
    createdByUserId: isAuthMode() ? getCurrentUserId(c) : null,
  })
  // List it now, so the first search finds it cached.
  background(listDirectoryNow(saved), { name: 'team-directory.first-listing' })
  await logAuditEvent({ userId: isAuthMode() ? getCurrentUserId(c) : null, object: 'team_directory', objectId: saved.id, action: 'connected', details: { provider, tenantName: tenant.tenantName } })
  const [view] = await views([saved])
  return c.json({ directory: view }, 201)
})

// POST /api/team-directories/:id/refresh - Lists the directory now: how many people it has, or why it can't be read.
router.post('/:id/refresh', async (c) => {
  const connection = await getDirectoryConnection(c.req.param('id'))
  if (!connection) return c.json({ error: 'Directory not found' }, 404)
  const result = await listDirectoryNow(connection)
  const [view] = await views([(await getDirectoryConnection(connection.id)) ?? connection])
  return c.json(result.ok ? { ok: true, userCount: result.users.length, directory: view } : { ok: false, error: result.error, directory: view })
})

// DELETE /api/team-directories/:id - Disconnects a directory. Its people stop appearing in searches at once.
router.delete('/:id', async (c) => {
  const removed = await deleteDirectoryConnection(c.req.param('id'))
  if (!removed) return c.json({ error: 'Directory not found' }, 404)
  await forgetDirectoryUsers(removed)
  await logAuditEvent({ userId: isAuthMode() ? getCurrentUserId(c) : null, object: 'team_directory', objectId: removed.id, action: 'disconnected', details: { provider: removed.provider, tenantName: removed.tenantName } })
  return c.body(null, 204)
})

export default router
