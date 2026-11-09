import { inArray, sql } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { user } from '@shared/lib/db/schema'
import { isAuthMode } from '@shared/lib/auth/mode'
import { searchUserSummaries } from '@shared/lib/services/user-profile-service'
import { normalizeProviderImage } from '@shared/lib/user-profile-schema'
import type { InviteCandidate } from './candidate-schema'
import { searchDirectoryPeople } from './search'

const DIRECTORY_RESULT_LIMIT = 50
/** A typed search waits this long for a directory nothing has been listed from yet; an empty one (the picker opening) only starts the listing. */
const FIRST_LISTING_WAIT_MS = 2_500

/** Which of these lowercased emails already belong to an account, of any status. */
async function emailsWithAccounts(emails: string[]): Promise<ReadonlySet<string>> {
  if (!emails.length) return new Set()
  const lowered = sql<string>`lower(${user.email})`
  const rows = await db.select({ email: lowered }).from(user).where(inArray(lowered, emails)).all()
  return new Set(rows.map((row) => row.email))
}

/**
 * Everyone an agent could be shared with: accounts first (as before), then,
 * in auth mode, directory people with no account. Callers authorize who may
 * see these (whoever can share the agent) and pass the agent's members to
 * leave out.
 */
export async function searchInviteCandidates(query: string | undefined, excludeUserIds: readonly string[]): Promise<InviteCandidate[]> {
  const accounts = (await searchUserSummaries(query, excludeUserIds)).map((profile): InviteCandidate => ({
    kind: 'user',
    id: profile.id,
    name: profile.name,
    email: profile.email,
    image: profile.image,
    notOnGamut: profile.invited === true,
  }))
  if (!isAuthMode()) return accounts

  const term = query?.trim() ?? ''
  const people = await searchDirectoryPeople(term, {
    limit: DIRECTORY_RESULT_LIMIT,
    waitMs: term ? FIRST_LISTING_WAIT_MS : 0,
    knownEmails: emailsWithAccounts,
  })
  return [
    ...accounts,
    ...people.map((person): InviteCandidate => ({
      kind: 'directory',
      directoryRef: { directoryId: person.sources[0].directoryId, remoteId: person.sources[0].remoteId },
      name: person.name,
      email: person.email,
      image: normalizeProviderImage(person.avatarUrl),
      notOnGamut: true,
      source: person.sources[0].directoryLabel,
    })),
  ]
}
