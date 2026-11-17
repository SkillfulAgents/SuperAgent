import { randomUUID } from 'node:crypto'
import { appState, defineNamespace, digestKeyPart, reduceRecord, type RecordChange, type StateKey } from '@shared/lib/app-state'
import { heldLoginRecordSchema, signInIdentitySchema, type HeldLoginRecord, type HeldPart, type SignInIdentity } from './held-values-schema'
import { usernameKey } from './site'
import { MAX_PARTS } from './vault-schemas'
import type { VaultOwner } from './vault-service'

/**
 * Sign-in state the host keeps between the steps of one sign-in, in AppState,
 * so every process that serves the tenant sees the same (docs/browser-vault.md):
 *
 * - Held values: what the user entered for a later step (the password asked
 *   together with the email on an email-first page), filled when a later
 *   request_login on the same site maps the field. One sign-in per agent,
 *   session and site at a time; held only once the step they came with went
 *   into the page, dropped once used, when the user declines or signs in by
 *   hand, or 30 minutes after they were held.
 * - The identity: the username the last step on the site went in with, so a
 *   step that shows no username field still knows whose account it is.
 *
 * A held value goes into a page once at most. A fill claims the parts it
 * sends before it sends them (`claimHeldParts`), and settles the claim with
 * what the browser said went in (`settleHeldClaim`): those are dropped, and
 * the rest are free again. A claim that is never settled (its process went
 * away) keeps its parts from everyone and drops them after `HELD_CLAIM_MS`:
 * they may have gone into the page.
 *
 * Whose values may go where (the agent's grants, the account named, the
 * page's origin) is decided by the callers, at the host boundary; this
 * module only keys them by agent, session and site. Values leave the host
 * only through the container's fill endpoint, never in a key, an event, a log
 * or anything the agent sees.
 *
 * How often a saved password went in is not kept here but in the audit log
 * (login-host's filledTooOften): it has to outlast a session and a restart.
 */

/** How long values are held: from the hold, not renewed by using some of them. */
export const HOLD_MS = 30 * 60 * 1000
/**
 * How long a claim keeps its parts for a fill in flight. Past it, the claim
 * counts as abandoned and its parts are dropped, not freed: the fill may have
 * gone in. Longer than any fill takes, so a fill that answers can still hand
 * back what did not go in.
 */
export const HELD_CLAIM_MS = 5 * 60 * 1000
/** Tries of one claim or settle when AppState does not answer (an answer may have been lost). */
const ATTEMPTS = 3

/** The ticket's `vault:held:{agentSlug}:{sessionId}:H(site)`. */
const heldLogins = defineNamespace({
  name: 'vault:held',
  consistency: 'strong',
  schema: heldLoginRecordSchema,
  // A hold sets 30 minutes; using or claiming some parts keeps that deadline.
  expiry: { ttlMs: HOLD_MS, onUpdate: 'keep' },
})

/** The ticket's `vault:identity:{agentSlug}:{sessionId}:H(site)`. */
const signInIdentities = defineNamespace({
  name: 'vault:identity',
  consistency: 'strong',
  schema: signInIdentitySchema,
  // 30 minutes from the latest remember.
  expiry: { ttlMs: HOLD_MS, onUpdate: 'reset' },
})

/** The held sign-in's key; the site is digested (no host names in keys). For tests and diagnostics. */
export function heldLoginKey(agentSlug: string, sessionId: string, site: string): StateKey<HeldLoginRecord, 'strong'> {
  return heldLogins.key(agentSlug, sessionId, digestKeyPart(site))
}

/** The recent identity's key. For tests and diagnostics. */
export function signInIdentityKey(agentSlug: string, sessionId: string, site: string): StateKey<SignInIdentity, 'strong'> {
  return signInIdentities.key(agentSlug, sessionId, digestKeyPart(site))
}

/** What a hold writes. */
export interface HeldLogin {
  username: string | null
  /** By part key ('password', 'text:…'). */
  values: Record<string, string>
  /** Where the user typed them: they go only where a saved account's would (vaultFillsInto). */
  origin: string
  /** Add them to the owner's account once they are filled: the user checked "Save for later". */
  save: { owner: VaultOwner; origin: string } | null
}

/** A held sign-in as read: the parts free to fill now, and the id of each. */
export interface HeldLoginRead extends HeldLogin {
  /** By part key: which held value it is, for a claim or release decided from this read. */
  ids: Record<string, string>
}

/** Parts a fill has taken. Settle it once the fill answered (or did not). */
export interface HeldClaim {
  readonly agentSlug: string
  readonly sessionId: string
  readonly site: string
  readonly id: string
  /** The claimed parts' values, as held: what the fill sends. */
  readonly values: Record<string, string>
}

/** The parts still kept at `now`: an abandoned claim's are dropped. */
function keptParts(parts: Record<string, HeldPart>, now: number): Record<string, HeldPart> {
  return Object.fromEntries(Object.entries(parts).filter(([, part]) => !part.claim || now < part.claim.until))
}

/** Writes `parts` as the record's (deleting it when none are left), keeping its deadline. */
function writeParts<R>(record: HeldLoginRecord, parts: Record<string, HeldPart>, result: R): RecordChange<HeldLoginRecord, R> {
  if (Object.keys(parts).length === 0) return { result, value: null }
  return { result, value: { ...record, parts }, expiry: 'keep' }
}

function sameParts(a: Record<string, HeldPart>, b: Record<string, HeldPart>): boolean {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key])
}

/** What AppState refused, for a log line: never its message, which a remote backend may fill with the request. */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error
}

/**
 * Holds what the user entered for a later step, for 30 minutes from now: it
 * replaces what was held on the site. With `carry` (an earlier read), the
 * parts of that read that are still held go along, unless `login` has newer
 * ones: a part forgotten or used since is not brought back. Whether anything
 * is held now.
 */
export async function holdLoginValues(
  agentSlug: string,
  sessionId: string,
  site: string,
  login: HeldLogin,
  options?: { carry?: HeldLoginRead | null },
): Promise<boolean> {
  const values = Object.fromEntries(Object.entries(login.values).filter(([, value]) => value))
  const carry = options?.carry ?? null
  if (Object.keys(values).length === 0 && !carry) return false
  return await reduceRecord(heldLoginKey(agentSlug, sessionId, site), (record): RecordChange<HeldLoginRecord, boolean> => {
    const parts: Record<string, HeldPart> = {}
    for (const [part, value] of Object.entries(values)) parts[part] = { value, id: randomUUID(), claim: null }
    if (record && carry) {
      for (const [part, entry] of Object.entries(keptParts(record.parts, Date.now()))) {
        if (Object.keys(parts).length >= MAX_PARTS) break
        if (!(part in parts) && carry.ids[part] === entry.id) parts[part] = entry
      }
    }
    if (Object.keys(parts).length === 0) return { result: false }
    const value: HeldLoginRecord = { username: login.username, origin: login.origin, save: login.save, parts }
    return { result: true, value, expiry: 'reset' }
  })
}

/** The held sign-in on a site, when it is for this username (any, when none is named): only its parts no fill has taken. */
export async function heldLoginFor(agentSlug: string, sessionId: string, site: string, username?: string): Promise<HeldLoginRead | null> {
  const entry = await appState().get(heldLoginKey(agentSlug, sessionId, site))
  if (!entry) return null
  const free = Object.entries(entry.value.parts).filter(([, part]) => part.claim === null)
  if (free.length === 0) return null
  const { username: heldFor, origin, save } = entry.value
  if (username && heldFor && usernameKey(heldFor) !== usernameKey(username)) return null
  return {
    username: heldFor,
    origin,
    save,
    values: Object.fromEntries(free.map(([part, { value }]) => [part, value])),
    ids: Object.fromEntries(free.map(([part, { id }]) => [part, id])),
  }
}

/**
 * Takes `parts` of a read for one fill, before the fill sends them: all of
 * them, or none when one was taken by another fill, used, or replaced since
 * (null). Retried with the same claim when AppState does not answer, since
 * the claim may have landed; a claim that cannot be confirmed is handed back
 * (or, failing that, lapses) and the error is thrown: nothing is filled.
 */
export async function claimHeldParts(
  agentSlug: string,
  sessionId: string,
  site: string,
  held: HeldLoginRead,
  parts: readonly string[],
): Promise<HeldClaim | null> {
  const wanted = [...new Set(parts)]
  if (wanted.length === 0) return null
  const key = heldLoginKey(agentSlug, sessionId, site)
  const id = randomUUID()
  let failure: unknown = null
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    try {
      const values = await reduceRecord(key, (record): RecordChange<HeldLoginRecord, Record<string, string> | null> => {
        if (!record) return { result: null }
        const now = Date.now()
        const current = keptParts(record.parts, now)
        for (const part of wanted) {
          const entry = current[part]
          if (!entry || entry.id !== held.ids[part]) return { result: null }
          if (entry.claim && entry.claim.id !== id) return { result: null }
        }
        const taken = Object.fromEntries(wanted.map((part) => [part, current[part].value]))
        // An earlier try landed and its answer was lost: the parts are this claim's already.
        if (wanted.every((part) => current[part].claim?.id === id)) return { result: taken }
        const next = { ...current }
        for (const part of wanted) next[part] = { ...current[part], claim: { id, until: now + HELD_CLAIM_MS } }
        return writeParts(record, next, taken)
      })
      return values ? { agentSlug, sessionId, site, id, values } : null
    } catch (error) {
      failure = error
    }
  }
  // It may have landed: hand it back, so the parts are not kept from the next try.
  await settleHeldClaim({ agentSlug, sessionId, site, id, values: {} }, [])
  throw failure
}

/**
 * Ends a claim once its fill answered: the parts in `used` went into the page
 * (or may have) and are dropped; the others are free again, while the claim
 * still stands. Pass every claimed part when the fill gave no answer. Retried
 * when AppState does not answer; past that the claim lapses, and its parts
 * are dropped.
 */
export async function settleHeldClaim(claim: HeldClaim, used: readonly string[]): Promise<void> {
  const key = heldLoginKey(claim.agentSlug, claim.sessionId, claim.site)
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    try {
      await reduceRecord(key, (record): RecordChange<HeldLoginRecord, void> => {
        if (!record) return { result: undefined }
        const now = Date.now()
        const next: Record<string, HeldPart> = {}
        for (const [part, entry] of Object.entries(record.parts)) {
          if (entry.claim?.id === claim.id) {
            if (!used.includes(part) && now < entry.claim.until) next[part] = { ...entry, claim: null }
            continue
          }
          if (entry.claim && entry.claim.until <= now) continue
          next[part] = entry
        }
        return sameParts(next, record.parts) ? { result: undefined } : writeParts(record, next, undefined)
      })
      return
    } catch (error) {
      if (attempt === ATTEMPTS - 1) {
        console.error(`[browser-vault] Could not settle a claim on held sign-in values (${errorName(error)}); its parts lapse with it`)
      }
    }
  }
}

/**
 * Drops `parts` of a read: the user typed newer values over them, or they
 * were saved to the account. Only those values: a part held again since stays,
 * and so do the others.
 */
export async function releaseHeldValues(agentSlug: string, sessionId: string, site: string, held: HeldLoginRead, parts: readonly string[]): Promise<void> {
  if (parts.length === 0) return
  await reduceRecord(heldLoginKey(agentSlug, sessionId, site), (record): RecordChange<HeldLoginRecord, void> => {
    if (!record) return { result: undefined }
    const current = keptParts(record.parts, Date.now())
    const next = Object.fromEntries(Object.entries(current).filter(([part, entry]) => !(parts.includes(part) && held.ids[part] === entry.id)))
    return sameParts(next, record.parts) ? { result: undefined } : writeParts(record, next, undefined)
  })
}

/** The user declined, or signed in on the page by hand: nothing they typed for later stays, even what a fill has taken. */
export async function forgetHeldLogin(agentSlug: string, sessionId: string, site: string): Promise<void> {
  await appState().delete(heldLoginKey(agentSlug, sessionId, site))
}

/**
 * The username a step on the site went in with: kept 30 minutes from the
 * latest. One too long to be a username (a password manager's entry can hold
 * anything) is not kept.
 */
export async function rememberSignInIdentity(agentSlug: string, sessionId: string, site: string, username: string): Promise<void> {
  const identity = signInIdentitySchema.safeParse({ username })
  if (!identity.success) return
  await appState().set(signInIdentityKey(agentSlug, sessionId, site), identity.data, { expiry: 'reset' })
}

export async function recentSignInIdentity(agentSlug: string, sessionId: string, site: string): Promise<string | null> {
  return (await appState().get(signInIdentityKey(agentSlug, sessionId, site)))?.value.username ?? null
}
