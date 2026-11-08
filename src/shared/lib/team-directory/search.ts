/**
 * Searching every connected directory at once. All of it happens here, the
 * same for every provider: listings come from the cache, people in several
 * directories are merged by verified email, and anyone who already has a
 * Gamut account is left to the account.
 */
import { getDirectoryProvider } from './registry'
import { cachedDirectoryUsers } from './cache'
import { listDirectoryConnections, type DirectoryConnection } from './store'
import type { DirectoryUser } from './types'

/** Where a merged person was found: enough to find them again in that directory. */
export interface DirectorySource {
  directoryId: string
  /** The directory as Settings names it: "Slack · Acme". */
  directoryLabel: string
  provider: string
  tenantId: string
  remoteId: string
}

/** One person, however many directories list them. */
export interface DirectoryPerson {
  name: string
  /** Lowercased, and verified by at least one directory. */
  email: string
  avatarUrl?: string
  /** In the order the directories were connected; the first names the person when they are picked. */
  sources: DirectorySource[]
}

export const normalizeEmail = (email: string) => email.trim().toLowerCase()

/**
 * One entry per person. People are merged only by an email a directory
 * verified: an unverified address could be anyone's, and could not safely
 * name the account they later sign in with, so a person without one is left
 * out. The first directory to list someone names them; a later one only fills
 * in a missing avatar.
 */
export function mergeDirectoryPeople(listings: ReadonlyArray<{ directoryId: string; directoryLabel: string; users: readonly DirectoryUser[] }>): DirectoryPerson[] {
  const byEmail = new Map<string, DirectoryPerson>()
  for (const { directoryId, directoryLabel, users } of listings) {
    for (const user of users) {
      if (!user.email || !user.emailVerified) continue
      const email = normalizeEmail(user.email)
      if (!email) continue
      const source: DirectorySource = { directoryId, directoryLabel, provider: user.provider, tenantId: user.tenantId, remoteId: user.remoteId }
      const known = byEmail.get(email)
      if (!known) {
        byEmail.set(email, { name: user.name, email, ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}), sources: [source] })
        continue
      }
      if (!known.sources.some((s) => s.directoryId === directoryId && s.remoteId === user.remoteId)) known.sources.push(source)
      if (!known.avatarUrl && user.avatarUrl) known.avatarUrl = user.avatarUrl
    }
  }
  return [...byEmail.values()]
}

/** 0: the name starts with the query; 1: a word of the name, or the email, does; 2: it is in there; null: no match. */
export function matchRank(query: string, person: Pick<DirectoryPerson, 'name' | 'email'>): number | null {
  const q = query.trim().toLowerCase()
  if (!q) return 0
  const name = person.name.toLowerCase()
  if (name.startsWith(q)) return 0
  if (name.split(/\s+/).some((word) => word.startsWith(q)) || person.email.startsWith(q)) return 1
  if (name.includes(q) || person.email.includes(q)) return 2
  return null
}

/** The people matching `query`, best match first, then by name. */
export function filterDirectoryPeople(people: readonly DirectoryPerson[], query: string, limit: number): DirectoryPerson[] {
  return people
    .map((person) => ({ person, rank: matchRank(query, person) }))
    .filter((entry): entry is { person: DirectoryPerson; rank: number } => entry.rank !== null)
    .sort((a, b) => a.rank - b.rank || a.person.name.localeCompare(b.person.name))
    .slice(0, limit)
    .map((entry) => entry.person)
}

export interface DirectorySearchOptions {
  limit: number
  /** How long to wait for a directory nothing has been listed from yet. */
  waitMs: number
  /** Emails that already belong to Gamut accounts; those people are found as accounts instead. */
  knownEmails: (emails: string[]) => Promise<ReadonlySet<string>>
}

/** Connected directories this build can open, in the order they were connected. */
async function usableConnections(): Promise<DirectoryConnection[]> {
  return (await listDirectoryConnections()).filter((connection) => getDirectoryProvider(connection.provider))
}

export function directoryLabel(connection: Pick<DirectoryConnection, 'provider' | 'tenantName'>): string {
  const provider = getDirectoryProvider(connection.provider)?.info.label ?? connection.provider
  return `${provider} · ${connection.tenantName}`
}

// Emails are checked against accounts this many at a time: D1 binds at most 100 parameters.
const KNOWN_EMAIL_CHUNK = 90

/** People in the connected directories matching `query` who have no Gamut account. */
export async function searchDirectoryPeople(query: string, options: DirectorySearchOptions): Promise<DirectoryPerson[]> {
  const connections = await usableConnections()
  if (!connections.length) return []
  const listings = await Promise.all(connections.map(async (connection) => ({
    directoryId: connection.id,
    directoryLabel: directoryLabel(connection),
    users: await cachedDirectoryUsers(connection, { waitMs: options.waitMs }),
  })))
  const matches = filterDirectoryPeople(mergeDirectoryPeople(listings), query, Number.POSITIVE_INFINITY)
  const found: DirectoryPerson[] = []
  for (let start = 0; start < matches.length && found.length < options.limit; start += KNOWN_EMAIL_CHUNK) {
    const chunk = matches.slice(start, start + KNOWN_EMAIL_CHUNK)
    const known = await options.knownEmails(chunk.map((person) => person.email))
    for (const person of chunk) {
      if (!known.has(person.email) && found.length < options.limit) found.push(person)
    }
  }
  return found
}
