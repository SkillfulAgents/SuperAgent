/**
 * People who aren't on Gamut yet, as real `user` rows with status 'invited'.
 *
 * A row is made the first time someone shares an agent with, or mentions, a
 * directory person, and not before: browsing a directory writes nothing. It
 * has no account, so nobody can sign in as it; access lists, mention chips and
 * notifications key on its id as they do for anyone. The person claims it by
 * signing in (auth/claim-invited-user.ts).
 */
import { randomUUID } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { user } from '@shared/lib/db/schema'
import { normalizeProviderImage } from '@shared/lib/user-profile-schema'
import { mintInviteToken } from '@shared/lib/auth/invite-tokens'
import { resolvePublicAppBaseUrl } from '@shared/lib/agent-integrations/app-link'
import { cachedDirectoryUsers } from './cache'
import { getDirectoryProvider } from './registry'
import { normalizeEmail } from './search'
import { listDirectoryConnections, openDirectory } from './store'
import type { DirectoryMessage, DirectoryUser } from './types'
import { INVITE_LINK_PARAM } from './invite-schema'

/** How long picking someone waits for their directory, when nothing is cached for it. */
const PICK_WAIT_MS = 10_000
const QUOTE_MAX = 280

/** A request about a directory person that can't be done, with a message for the person asking. */
export class DirectoryInviteError extends Error {
  constructor(message: string, readonly status: 400 | 404) {
    super(message)
    this.name = 'DirectoryInviteError'
  }
}

export interface DirectoryRef {
  directoryId: string
  remoteId: string
}

/** The person as their directory lists them now. */
async function findDirectoryUser(ref: DirectoryRef): Promise<DirectoryUser | null> {
  const connection = (await listDirectoryConnections()).find((c) => c.id === ref.directoryId)
  if (!connection || !getDirectoryProvider(connection.provider)) return null
  const users = await cachedDirectoryUsers(connection, { waitMs: PICK_WAIT_MS })
  return users.find((u) => u.remoteId === ref.remoteId) ?? null
}

async function userByEmail(email: string) {
  return db.select({ id: user.id, status: user.status }).from(user)
    .where(sql`lower(${user.email}) = ${email}`).get()
}

/**
 * The user row for a directory person: theirs if they already have one (by
 * email, of any status), else a new invited row. Only a verified email names
 * a row, since whoever later signs in with that email claims it.
 */
export async function inviteDirectoryPerson(ref: DirectoryRef, invitedByUserId: string): Promise<{ userId: string; invited: boolean }> {
  const person = await findDirectoryUser(ref)
  if (!person) throw new DirectoryInviteError('That person is no longer in the directory.', 404)
  if (!person.email || !person.emailVerified) throw new DirectoryInviteError(`${person.name} has no verified email in the directory.`, 400)
  const email = normalizeEmail(person.email)

  const existing = await userByEmail(email)
  if (existing) return { userId: existing.id, invited: existing.status === 'invited' }

  const now = new Date()
  // Two people inviting the same person at once both land on the one row.
  await db.insert(user).values({
    id: randomUUID(),
    name: person.name,
    email,
    // Gamut has not verified it; joining does (claim-invited-user.ts).
    emailVerified: false,
    image: normalizeProviderImage(person.avatarUrl),
    role: 'user',
    status: 'invited',
    invitedByUserId,
    directoryProvider: person.provider,
    directoryTenantId: person.tenantId,
    directoryRemoteId: person.remoteId,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing().run()
  const created = await userByEmail(email)
  if (!created) throw new Error('The invited user was not saved')
  return { userId: created.id, invited: created.status === 'invited' }
}

/** Why someone is being told about Gamut. */
export type InviteNotice =
  | { kind: 'shared'; agentName: string; byName: string }
  | { kind: 'mentioned'; agentName: string; byName: string; text: string }

function messageFor(notice: InviteNotice, url: string): DirectoryMessage {
  if (notice.kind === 'shared') {
    return { headline: `${notice.byName} shared the agent ${notice.agentName} with you on Gamut.`, link: { label: 'Join Gamut to use it', url } }
  }
  const text = notice.text.trim()
  return {
    headline: `${notice.byName} mentioned you in ${notice.agentName} on Gamut:`,
    ...(text ? { quote: text.length > QUOTE_MAX ? `${text.slice(0, QUOTE_MAX - 1).trimEnd()}…` : text } : {}),
    link: { label: 'Join Gamut to reply', url },
  }
}

export type NotifyOutcome = 'sent' | 'not-invited' | 'no-channel'

/**
 * Tells an invited person, outside Gamut, that something is waiting for them,
 * with a link to join. It goes through the directory they were invited from,
 * when that directory can message people; anyone else is told nothing here
 * (in Gamut, the notification waits for them either way).
 */
export async function notifyInvitedUser(userId: string, notice: InviteNotice): Promise<NotifyOutcome> {
  const row = await db.select({
    status: user.status, name: user.name, email: user.email,
    provider: user.directoryProvider, tenantId: user.directoryTenantId, remoteId: user.directoryRemoteId,
  }).from(user).where(eq(user.id, userId)).get()
  if (!row || row.status !== 'invited') return 'not-invited'
  if (!row.provider || !row.tenantId || !row.remoteId) return 'no-channel'
  const connection = (await listDirectoryConnections()).find((c) => c.provider === row.provider && c.tenantId === row.tenantId)
  if (!connection || !getDirectoryProvider(connection.provider)) return 'no-channel'
  const directory = await openDirectory(connection)
  if (!directory.notifyUser) return 'no-channel'
  const base = await resolvePublicAppBaseUrl()
  if (!base) return 'no-channel'

  const url = `${base}/?${INVITE_LINK_PARAM}=${encodeURIComponent(await mintInviteToken(userId))}`
  await directory.notifyUser(
    { provider: row.provider, tenantId: row.tenantId, remoteId: row.remoteId, name: row.name, email: row.email, emailVerified: true },
    messageFor(notice, url),
  )
  return 'sent'
}
