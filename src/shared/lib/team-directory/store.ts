/**
 * Connected directories (`team_directories`). Credentials are sealed on the
 * way in and opened only to build a provider's client; nothing returned from
 * here to a route carries them.
 */
import { randomUUID } from 'node:crypto'
import { and, asc, eq, isNull, ne, or, sql } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { teamDirectories, type TeamDirectoryRow } from '@shared/lib/db/schema'
import { openDirectoryCredentials, sealDirectoryCredentials } from './credentials'
import { getDirectoryProvider } from './registry'
import type { DirectoryTenant, TeamDirectory } from './types'

export type DirectoryConnection = Omit<TeamDirectoryRow, 'credentials'>

// Built on use, not at import: the search route imports this module, and many
// route tests stand in a partial schema for the real one.
const publicColumns = () => ({
  id: teamDirectories.id,
  provider: teamDirectories.provider,
  tenantId: teamDirectories.tenantId,
  tenantName: teamDirectories.tenantName,
  revision: teamDirectories.revision,
  status: teamDirectories.status,
  errorMessage: teamDirectories.errorMessage,
  createdByUserId: teamDirectories.createdByUserId,
  createdAt: teamDirectories.createdAt,
  updatedAt: teamDirectories.updatedAt,
})

export async function listDirectoryConnections(): Promise<DirectoryConnection[]> {
  return db.select(publicColumns()).from(teamDirectories).orderBy(asc(teamDirectories.createdAt)).all()
}

export async function getDirectoryConnection(id: string): Promise<DirectoryConnection | null> {
  return (await db.select(publicColumns()).from(teamDirectories).where(eq(teamDirectories.id, id)).get()) ?? null
}

/**
 * Stores verified credentials. Connecting a workspace that is already
 * connected replaces its credentials (a new token with more scopes, say) and
 * moves its revision, so listings made with the old ones are not reused.
 */
export async function saveDirectoryConnection(input: {
  provider: string
  tenant: DirectoryTenant
  credentials: unknown
  createdByUserId: string | null
}): Promise<DirectoryConnection> {
  const now = new Date()
  const credentials = await sealDirectoryCredentials(input.provider, input.tenant.tenantId, input.credentials)
  const saved = await db.insert(teamDirectories).values({
    id: randomUUID(),
    provider: input.provider,
    tenantId: input.tenant.tenantId,
    tenantName: input.tenant.tenantName,
    credentials,
    createdByUserId: input.createdByUserId,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: [teamDirectories.provider, teamDirectories.tenantId],
    set: {
      tenantName: input.tenant.tenantName,
      credentials,
      revision: sql`${teamDirectories.revision} + 1`,
      status: 'active',
      errorMessage: null,
      updatedAt: now,
    },
  }).returning(publicColumns()).get()
  if (!saved) throw new Error('The directory was not saved')
  return saved
}

export async function deleteDirectoryConnection(id: string): Promise<DirectoryConnection | null> {
  return (await db.delete(teamDirectories).where(eq(teamDirectories.id, id)).returning(publicColumns()).get()) ?? null
}

/** The provider's client for a stored connection. Throws when its provider is gone from this build or its credentials no longer open. */
export async function openDirectory(connection: DirectoryConnection): Promise<TeamDirectory> {
  const provider = getDirectoryProvider(connection.provider)
  if (!provider) throw new Error(`This version of the app has no ${connection.provider} directory`)
  const row = await db.select({ credentials: teamDirectories.credentials }).from(teamDirectories)
    .where(and(eq(teamDirectories.id, connection.id), eq(teamDirectories.revision, connection.revision))).get()
  if (!row) throw new Error('The directory changed while it was being read')
  const credentials = provider.credentialsSchema.parse(await openDirectoryCredentials(connection.provider, connection.tenantId, row.credentials))
  return provider.open({ id: connection.id, tenantId: connection.tenantId, credentials })
}

/**
 * Records how the last listing went. Written only for the credentials it was
 * made with, and only when it changes something, so a healthy directory's
 * searches never write.
 */
export async function recordDirectoryHealth(connection: Pick<DirectoryConnection, 'id' | 'revision'>, errorMessage: string | null): Promise<void> {
  const status = errorMessage ? 'error' : 'active'
  await db.update(teamDirectories)
    .set({ status, errorMessage, updatedAt: new Date() })
    .where(and(
      eq(teamDirectories.id, connection.id),
      eq(teamDirectories.revision, connection.revision),
      errorMessage
        ? or(ne(teamDirectories.status, status), isNull(teamDirectories.errorMessage), ne(teamDirectories.errorMessage, errorMessage))
        : ne(teamDirectories.status, status),
    ))
    .run()
}
