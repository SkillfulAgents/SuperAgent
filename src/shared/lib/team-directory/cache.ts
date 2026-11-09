/**
 * Each directory's people, cached in AppState rather than stored: a listing is
 * one or two paged calls, so it is cheap to make again and never needs a sync.
 *
 * - A listing is fresh for ten minutes. After that the cached one is still
 *   answered at once while a new one is made in the background.
 * - A directory with no listing yet is listed on the spot; a search waits for
 *   it up to a budget and answers without that directory if it runs over.
 * - A failed listing keeps the last good one, is not tried again for a
 *   minute, and marks the directory as failing in Settings.
 *
 * Listings are keyed by the directory's credentials revision, so reconnecting
 * starts afresh. The namespace is eventual (a plain, non-atomic cache): two
 * processes may both list a stale directory, and the later write wins.
 */
import { z } from 'zod'
import { appState, defineNamespace } from '@shared/lib/app-state'
import { background } from '@shared/lib/background'
import { openDirectory, recordDirectoryHealth, type DirectoryConnection } from './store'
import { DirectoryConnectError, type DirectoryUser } from './types'

export const LISTING_FRESH_MS = 10 * 60_000
export const LISTING_RETRY_MS = 60_000
/** How long a listing nobody asks for is kept to answer from while the next one is made. */
const LISTING_KEPT_MS = 6 * 60 * 60_000

export const directoryUserSchema = z.object({
  provider: z.string(),
  tenantId: z.string(),
  remoteId: z.string(),
  name: z.string(),
  email: z.string().optional(),
  emailVerified: z.boolean(),
  avatarUrl: z.string().optional(),
})

const listingSchema = z.object({
  /** When the people were last listed; null when no listing has succeeded. */
  listedAt: z.number().nullable(),
  /** The last attempt, successful or not. */
  attemptedAt: z.number(),
  users: z.array(directoryUserSchema),
})
type Listing = z.infer<typeof listingSchema>

const listings = defineNamespace({
  name: 'cache:team-directory',
  consistency: 'eventual',
  schema: listingSchema,
  expiry: { ttlMs: LISTING_KEPT_MS, onUpdate: 'reset' },
})

const listingKey = (connection: Pick<DirectoryConnection, 'id' | 'revision'>) => listings.key(connection.id, String(connection.revision))

/** This process's listing in progress per directory, so concurrent searches make one. Never rejects. */
const loading = new Map<string, Promise<ListResult>>()

export type ListResult = { ok: true; users: DirectoryUser[] } | { ok: false; error: string }

function describeListingError(error: unknown): string {
  if (error instanceof DirectoryConnectError) return error.message
  return `Listing people failed: ${error instanceof Error ? error.message : String(error)}`
}

async function list(connection: DirectoryConnection): Promise<ListResult> {
  const key = listingKey(connection)
  const now = Date.now()
  try {
    const users = await (await openDirectory(connection)).listUsers()
    await appState().set(key, { listedAt: now, attemptedAt: now, users })
    await recordDirectoryHealth(connection, null)
    return { ok: true, users }
  } catch (error) {
    const message = describeListingError(error)
    console.warn(`[TeamDirectory] Listing ${connection.provider} directory ${connection.id} failed: ${message}`)
    try {
      // Keep what was listed before, and note the attempt so it isn't retried at once.
      const previous = await appState().get(key)
      await appState().set(key, {
        listedAt: previous?.value.listedAt ?? null,
        attemptedAt: now,
        users: previous?.value.users ?? [],
      }, previous?.expiresAt ? { expiry: { at: previous.expiresAt } } : {})
      await recordDirectoryHealth(connection, message)
    } catch (recordError) {
      console.error('[TeamDirectory] Recording a failed listing failed:', recordError)
    }
    return { ok: false, error: message }
  }
}

/** Lists the directory now (joining a listing already running here), and caches the result. */
export function listDirectoryNow(connection: DirectoryConnection): Promise<ListResult> {
  const path = listingKey(connection).path
  const running = loading.get(path)
  if (running) return running
  const started = list(connection).finally(() => loading.delete(path))
  loading.set(path, started)
  return started
}

function isDue(listing: Listing | undefined, now: number): boolean {
  if (!listing) return true
  if (listing.listedAt !== null && now - listing.listedAt < LISTING_FRESH_MS) return false
  return now - listing.attemptedAt >= LISTING_RETRY_MS
}

export interface CachedUsersOptions {
  /** How long to wait for a directory that has no listing yet. 0 starts the listing and answers without it. */
  waitMs: number
}

/** A directory's people from the cache, refreshing it when due. Never throws: a directory that cannot answer contributes nobody. */
export async function cachedDirectoryUsers(connection: DirectoryConnection, options: CachedUsersOptions): Promise<DirectoryUser[]> {
  let listing: Listing | undefined
  try {
    listing = (await appState().get(listingKey(connection)))?.value
  } catch (error) {
    console.error('[TeamDirectory] Reading a cached listing failed:', error)
  }
  if (!isDue(listing, Date.now())) return listing?.users ?? []

  const refreshing = listDirectoryNow(connection)
  background(refreshing, { name: 'team-directory.refresh' })
  // Stale or failing: answer with what was listed before.
  if (listing?.listedAt != null || !options.waitMs) return listing?.users ?? []

  let timer: ReturnType<typeof setTimeout> | undefined
  const overBudget = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), options.waitMs) })
  const result = await Promise.race([refreshing, overBudget]).finally(() => clearTimeout(timer))
  return result?.ok ? result.users : listing?.users ?? []
}

/** Drops a directory's cached people (it was disconnected). */
export async function forgetDirectoryUsers(connection: Pick<DirectoryConnection, 'id' | 'revision'>): Promise<void> {
  await appState().delete(listingKey(connection))
}
