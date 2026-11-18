/**
 * How many device sign-ins the tenant may have pending at once: at most 100,
 * counting the ones whose provider is still being asked for a device code,
 * across every process that serves the tenant.
 *
 * One strong AppState record lists them. Each change is one conditional write
 * decided from what the record holds (`reduceRecord`), so two processes
 * cannot both take the last place. An entry stops counting at its `expiresAt`
 * and the next write drops it, so a place whose process went away comes back
 * by itself, which a counter would not.
 *
 * An entry is first a reservation that lasts as long as a provider start can,
 * then the sign-in itself until the provider's device expiry. A save or a
 * cancel removes it; a sign-in the provider failed keeps its place until its
 * expiry, as every started sign-in did before.
 */
import { z } from 'zod'
import { defineNamespace, reduceRecord, type RecordChange, type StateKey } from '../app-state'

/** Sign-ins the tenant may have pending at once. */
export const OAUTH_LOGIN_LIMIT = 100
/**
 * How long a place is reserved while the provider is asked for a device code:
 * longer than the slowest provider start (Grok's 15 s discovery and 20 s
 * device request).
 */
export const OAUTH_LOGIN_START_MS = 60_000
/**
 * Decisions one change may take. Each conflict means another change landed,
 * and a burst of starts can make up to three per place (reserve, activate,
 * remove), so this outlasts every start of a full burst.
 */
const MAX_ATTEMPTS = 4 * OAUTH_LOGIN_LIMIT

const placeSchema = z.object({
  /** The sign-in's id. */
  id: z.uuid(),
  /** Epoch ms, by the clock of the process that wrote it: when this place stops counting. */
  expiresAt: z.number().finite(),
})
type Place = z.infer<typeof placeSchema>

const placesSchema = z.object({
  places: z.array(placeSchema).min(1).max(OAUTH_LOGIN_LIMIT)
    .refine(places => new Set(places.map(place => place.id)).size === places.length, 'Sign-in ids are unique'),
})
export type OAuthLoginPlaces = z.infer<typeof placesSchema>

const pendingLogins = defineNamespace({
  name: 'oauth:llm:pending',
  consistency: 'strong',
  schema: placesSchema,
  // Every write sets the record's expiry to its last place's (`write`); this
  // only bounds a record written some other way.
  expiry: { ttlMs: 60 * 60 * 1000, onUpdate: 'keep' },
})

/** The tenant's record (an AppState instance serves one tenant), for tests. Only this module writes it. */
export function pendingLoginsKey(): StateKey<OAuthLoginPlaces, 'strong'> {
  return pendingLogins.key('tenant')
}

function live(record: OAuthLoginPlaces | null, now: number): Place[] {
  return (record?.places ?? []).filter(place => now < place.expiresAt)
}

/** Writes `places` as the record, expiring with its last place; deletes it when empty. */
function write<R>(places: Place[], result: R): RecordChange<OAuthLoginPlaces, R> {
  if (places.length === 0) return { result, value: null }
  return { result, value: { places }, expiry: { at: Math.max(...places.map(place => place.expiresAt)) } }
}

/**
 * Takes a place for sign-in `id` while the provider is asked for its device
 * code, when fewer than 100 are taken. True when it holds one (also when an
 * earlier attempt whose answer was lost took it).
 */
export async function reserveOAuthLoginPlace(id: string): Promise<boolean> {
  return await reduceRecord(pendingLoginsKey(), (record) => {
    const now = Date.now()
    const places = live(record, now)
    if (places.some(place => place.id === id)) return { result: true }
    if (places.length >= OAUTH_LOGIN_LIMIT) return { result: false }
    return write([...places, { id, expiresAt: now + OAUTH_LOGIN_START_MS }], true)
  }, { maxAttempts: MAX_ATTEMPTS })
}

/**
 * The provider answered: the place counts until the sign-in's device expiry.
 * A reservation that ran out meanwhile is taken again only if a place is
 * free. False when none is. Repeating it changes nothing.
 */
export async function activateOAuthLoginPlace(id: string, expiresAt: number): Promise<boolean> {
  return await reduceRecord(pendingLoginsKey(), (record) => {
    const places = live(record, Date.now())
    const held = places.find(place => place.id === id)
    if (held?.expiresAt === expiresAt) return { result: true }
    if (held) return write(places.map(place => place.id === id ? { id, expiresAt } : place), true)
    if (places.length >= OAUTH_LOGIN_LIMIT) return { result: false }
    return write([...places, { id, expiresAt }], true)
  }, { maxAttempts: MAX_ATTEMPTS })
}

/** Frees sign-in `id`'s place, if it holds one. */
export async function releaseOAuthLoginPlace(id: string): Promise<void> {
  await reduceRecord(pendingLoginsKey(), (record) => {
    const all = record?.places ?? []
    if (!all.some(place => place.id === id)) return { result: undefined }
    return write(live(record, Date.now()).filter(place => place.id !== id), undefined)
  }, { maxAttempts: MAX_ATTEMPTS })
}
