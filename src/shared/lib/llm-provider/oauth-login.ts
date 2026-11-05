/**
 * Device sign-in for subscription providers (Grok, Codex, Kimi, MiniMax),
 * shared by every process that serves the tenant: any of them can start,
 * poll, save or cancel a sign-in another one started.
 *
 * A sign-in is one strong AppState record (`oauth:llm`, keyed by its id): the
 * provider's device data, what polling that provider needs, who started it,
 * the connection it is for, the provider's device expiry and the poll
 * schedule. Each write carries that expiry unchanged, so nothing extends it.
 * The process that polls rebuilds the provider call from the record.
 *
 * - Starting takes one of the tenant's 100 places first
 *   (`oauth-login-admission.ts`).
 * - Polling the provider takes a lease on the sign-in, confirmed right before
 *   the request for longer than the request can take, so two polls never ask
 *   the provider at once. The answer is written only over the record the poll
 *   decided from, so a late answer never replaces a newer one.
 * - A save takes the credential (`saving`) over the record it read, writes it
 *   to its connection in the database, then removes the sign-in. A cancel or
 *   expiry before the take refuses the save; a second save of the same sign-in
 *   is refused too.
 *
 * Secret-bearing fields (the device code, MiniMax's PKCE verifier, the issued
 * credential) are stored as they are; sealing them is a separate change. They
 * never appear in keys, errors or logs.
 */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { appState, defineLease, defineNamespace, LeaseLostError, type Entry, type LeaseHolding, type StateKey } from '../app-state'
import { startCodexLogin, pollCodexLogin } from './codex-oauth'
import { startGrokLogin, pollGrokLogin } from './grok-oauth'
import { startKimiLogin, pollKimiLogin, kimiRegion } from './kimi-oauth'
import { startMinimaxLogin, pollMinimaxLogin, minimaxRegion } from './minimax-oauth'
import { activateOAuthLoginPlace, releaseOAuthLoginPlace, reserveOAuthLoginPlace } from './oauth-login-admission'
import { oauthLoginSchema, type OAuthLogin, type OAuthLoginProvider } from './oauth-login-schema'
import type { OAuthCredential } from './oauth-schema'
import type { ConnectionViewer } from './connections'
import type { OAuthProvider } from './provider-types'
export type { OAuthProvider } from './provider-types'

type Device = { device_code: string; user_code: string; verification_uri: string; verification_uri_complete?: string; expires_in: number; interval: number }
type PollResult = { pending: 'authorization_pending' | 'slow_down' } | { credential: OAuthCredential }
// Each flow validates the options it understands; others ignore them.
export type OAuthLoginOptions = { region?: string }
export type OAuthLoginStatus = { status: 'pending' } | { status: 'connected'; accountLabel: string }

/**
 * The longest a provider poll can take: Codex's two 20 s requests (Grok's and
 * Kimi's are 20 s and 15 s). A poll is sent only while its lease is held for
 * at least this much longer.
 */
export const OAUTH_POLL_REQUEST_TIMEOUT_MS = 45_000
/** Longer than a poll request plus a renewal. */
export const OAUTH_POLL_LEASE_MS = 60_000
/** What the lease must still have left when a poll's answer is written. */
const PUBLISH_MARGIN_MS = 5_000
/** Tries at one write whose answers were lost. */
const LOST_ANSWER_ATTEMPTS = 3
/** Decisions a cancel takes when polls keep writing under it. */
const CANCEL_ATTEMPTS = 8

const EXPIRED = 'Sign-in expired. Start again.'
const TOO_MANY = 'Too many pending sign-ins. Please retry shortly.'

const logins = defineNamespace({
  name: 'oauth:llm',
  consistency: 'strong',
  schema: oauthLoginSchema,
  // Every write passes the device expiry (`{ at }`); this only bounds a record
  // written some other way.
  expiry: { ttlMs: 60 * 60 * 1000, onUpdate: 'keep' },
})

/** A sign-in's record, for tests. Only this module writes it. */
export function oauthLoginKey(id: string): StateKey<OAuthLogin, 'strong'> {
  return logins.key(id)
}

/** Held by the one request that is asking the provider about a sign-in. */
const pollClaims = defineLease({ name: 'claim:llm-oauth-poll', ttlMs: OAUTH_POLL_LEASE_MS })

const starts: Record<OAuthProvider, (options: OAuthLoginOptions) => Promise<{ device: Device; provider: OAuthLoginProvider }>> = {
  'grok-subscription': async () => {
    const { device, endpoints } = await startGrokLogin()
    return { device, provider: { provider: 'grok-subscription', tokenEndpoint: endpoints.token_endpoint, userinfoEndpoint: endpoints.userinfo_endpoint } }
  },
  'codex-subscription': async () => {
    const { device } = await startCodexLogin()
    return { device, provider: { provider: 'codex-subscription' } }
  },
  'kimi-subscription': async options => {
    const region = kimiRegion(options.region)
    const { device } = await startKimiLogin(region)
    return { device, provider: { provider: 'kimi-subscription', region } }
  },
  'minimax-subscription': async options => {
    const region = minimaxRegion(options.region)
    const login = await startMinimaxLogin(region)
    return { device: login.device, provider: { provider: 'minimax-subscription', region, verifier: login.verifier } }
  },
}

/** The provider's poll, rebuilt from the record. */
async function askProvider(login: OAuthLogin): Promise<PollResult> {
  const { provider, device } = login
  switch (provider.provider) {
    case 'grok-subscription': return pollGrokLogin(device.device_code, provider.tokenEndpoint, provider.userinfoEndpoint)
    case 'codex-subscription': return pollCodexLogin(device.device_code, device.user_code)
    case 'kimi-subscription': return pollKimiLogin(device.device_code, provider.region)
    case 'minimax-subscription': return pollMinimaxLogin({
      device: {
        device_code: device.device_code, user_code: device.user_code, verification_uri: device.verification_uri,
        expires_in: Math.max(1, Math.ceil((login.expiresAt - Date.now()) / 1000)), interval: login.schedule.intervalSeconds,
      },
      userCode: device.user_code,
      verifier: provider.verifier,
    }, provider.region)
  }
}

const loginIdSchema = z.uuid()

function mayUse(login: OAuthLogin, viewer: ConnectionViewer): boolean {
  return login.initiatingUserId === viewer.userId && (login.ownerId !== null || viewer.admin)
}

/** The sign-in, while it exists, has not expired, and `viewer` started it; otherwise the same error for all three. */
async function readLogin(id: string, viewer: ConnectionViewer): Promise<Entry<OAuthLogin>> {
  if (!loginIdSchema.safeParse(id).success) throw new Error(EXPIRED)
  const entry = await appState().get(logins.key(id))
  if (!entry || entry.value.expiresAt <= Date.now() || !mayUse(entry.value, viewer)) throw new Error(EXPIRED)
  return entry
}

/**
 * Writes `next` while the sign-in is still the write `seen`, keeping its
 * device expiry. Null when it changed or went away meanwhile. An answer that
 * is lost may hide a write that landed: the sign-in is read back, and the
 * write is tried again only while the sign-in is still `seen`.
 */
async function writeLogin(id: string, seen: Entry<OAuthLogin>, next: OAuthLogin): Promise<Entry<OAuthLogin> | null> {
  const key = logins.key(id)
  // Checked first, so a value the schema refuses is not taken for a lost answer.
  oauthLoginSchema.parse(next)
  for (let attempt = 1; ; attempt++) {
    try {
      const written = await appState().compareAndSet(key, seen.revision, next, { expiry: { at: seen.value.expiresAt } })
      return written.ok ? written.entry : null
    } catch (error) {
      const current = await appState().get(key)
      if (current?.value.writeId === next.writeId) return current
      if (current?.revision !== seen.revision) return null
      if (attempt >= LOST_ANSWER_ATTEMPTS) throw error
    }
  }
}

/** Frees a sign-in's place, or leaves it to free itself at the device expiry. */
async function freePlace(id: string): Promise<void> {
  try {
    await releaseOAuthLoginPlace(id)
  } catch (error) {
    console.warn('[llm-oauth] Could not free a sign-in\'s place; it frees itself when the device code expires:', error)
  }
}

/**
 * Starts a device sign-in for `viewer`, for the connection `connectionId` (or
 * a new one) owned by `owner`, once a place is free. The device code stays
 * here; the caller gets the user code and where to enter it.
 */
export async function startOAuthLogin(viewer: ConnectionViewer, owner: string | null, connectionId?: string, provider: OAuthProvider = 'grok-subscription', options: OAuthLoginOptions = {}) {
  const id = randomUUID()
  try {
    if (!(await retryingLostAnswers(() => reserveOAuthLoginPlace(id)))) throw new Error(TOO_MANY)
    const started = await starts[provider](options)
    const { device } = started
    const expiresAt = Date.now() + device.expires_in * 1000
    const login: OAuthLogin = {
      provider: started.provider,
      device: {
        device_code: device.device_code,
        user_code: device.user_code,
        verification_uri: device.verification_uri,
        ...(device.verification_uri_complete ? { verification_uri_complete: device.verification_uri_complete } : {}),
      },
      initiatingUserId: viewer.userId,
      ownerId: owner,
      ...(connectionId ? { connectionId } : {}),
      expiresAt,
      schedule: { intervalSeconds: device.interval, nextPollAt: 0 },
      status: { state: 'pending' },
      writeId: randomUUID(),
    }
    await insertLogin(id, login)
    if (!(await retryingLostAnswers(() => activateOAuthLoginPlace(id, expiresAt)))) throw new Error(TOO_MANY)
    return { id, url: device.verification_uri_complete ?? device.verification_uri, code: device.user_code, expiresAt, interval: device.interval }
  } catch (error) {
    // Whatever was written may have landed, its answer lost or not: nothing
    // of a start that failed is left behind. Its id never reached anyone.
    try {
      await appState().consume(logins.key(id))
    } catch (cleanup) {
      console.warn('[llm-oauth] Could not remove an unfinished sign-in; it expires with its device code:', cleanup)
    }
    await freePlace(id)
    throw error
  }
}

async function insertLogin(id: string, login: OAuthLogin): Promise<void> {
  const result = await retryingLostAnswers(() => appState().insertIfAbsent(logins.key(id), login, { expiry: { at: login.expiresAt } }))
  // A fresh random id: what is there is this start's own write, from an attempt whose answer was lost.
  if (!result.inserted && result.current.value.writeId !== login.writeId) throw new Error('A sign-in with this id already exists')
}

/** For a write that is the same whether it lands once or again: tried again when its answer is lost. */
async function retryingLostAnswers<T>(write: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await write()
    } catch (error) {
      if (attempt >= LOST_ANSWER_ATTEMPTS) throw error
    }
  }
}

function isDue(login: OAuthLogin): boolean {
  return login.status.state === 'pending' && Date.now() >= login.schedule.nextPollAt
}

function statusOf(login: OAuthLogin): OAuthLoginStatus {
  switch (login.status.state) {
    case 'pending': return { status: 'pending' }
    case 'completed':
    case 'saving': return { status: 'connected', accountLabel: login.status.credential.accountLabel ?? 'Subscription account' }
    case 'failed': throw new Error(login.status.message)
  }
}

/**
 * Where a sign-in stands for `viewer`, asking the provider when a poll is due
 * and no other request is asking it now. Throws the provider's message once
 * it ended the sign-in, and one message for a sign-in that expired, was
 * removed, or is someone else's.
 */
export async function pollOAuthLogin(id: string, viewer: ConnectionViewer): Promise<OAuthLoginStatus> {
  const seen = await readLogin(id, viewer)
  if (!isDue(seen.value)) return statusOf(seen.value)
  const lease = await pollClaims.acquire(pollClaims.key(id))
  // Another request is asking the provider; it writes what it hears.
  if (!lease) return { status: 'pending' }
  try {
    return await pollClaims.hold(lease, holding => pollOnce(id, viewer, holding))
  } catch (error) {
    // Losing the lease is not the sign-in's failure: the next poll asks again.
    if (error instanceof LeaseLostError) return { status: 'pending' }
    throw error
  }
}

async function pollOnce(id: string, viewer: ConnectionViewer, holding: LeaseHolding): Promise<OAuthLoginStatus> {
  // Decided from what is stored now that this request holds the lease: the
  // previous holder may have written since the first read.
  const seen = await readLogin(id, viewer)
  if (!isDue(seen.value)) return statusOf(seen.value)
  // Nothing awaited between this and the request: the lease outlasts it.
  await holding.confirm({ minRemainingMs: OAUTH_POLL_REQUEST_TIMEOUT_MS })
  const sentAt = Date.now()
  const answer = await askProvider(seen.value).catch((error: unknown) => ({ failed: failureMessage(error) }))
  const next = afterPoll(seen.value, answer, sentAt)
  const held = await holding.confirm({ minRemainingMs: PUBLISH_MARGIN_MS }).then(() => true, () => false)
  // Without the lease another request may be asking the provider now, and
  // its answer counts more than a stale one. Only a credential is still
  // worth writing, and only over the record this poll decided from.
  if (!held && !('credential' in answer)) return { status: 'pending' }
  const written = await writeLogin(id, seen, next)
  // Null: the sign-in was cancelled, expired or written since. The answer is
  // dropped, and the caller hears what is stored now.
  return statusOf(written ? written.value : (await readLogin(id, viewer)).value)
}

type Answer = PollResult | { failed: string }

function afterPoll(login: OAuthLogin, answer: Answer, sentAt: number): OAuthLogin {
  const writeId = randomUUID()
  if ('credential' in answer) return { ...login, writeId, status: { state: 'completed', credential: answer.credential } }
  if ('failed' in answer) return { ...login, writeId, status: { state: 'failed', message: answer.failed } }
  if (answer.pending === 'slow_down') {
    const intervalSeconds = login.schedule.intervalSeconds + 5
    return { ...login, writeId, schedule: { intervalSeconds, nextPollAt: Date.now() + intervalSeconds * 1000 } }
  }
  return { ...login, writeId, schedule: { ...login.schedule, nextPollAt: sentAt + login.schedule.intervalSeconds * 1000 } }
}

/**
 * What a failed poll tells the user: a provider module's own message (a
 * declined or expired sign-in), else a generic one, since a network or parse
 * error may say more than it should.
 */
function failureMessage(error: unknown): string {
  if (error instanceof Error && error.name === 'Error' && error.message) return error.message.slice(0, 500)
  return 'Sign-in failed. Start again.'
}

/** A completed sign-in, as the save that will take its credential read it. */
export interface CompletedOAuthLogin {
  readonly id: string
  readonly entry: Entry<OAuthLogin>
  readonly credential: OAuthCredential
}

/**
 * The credential of a sign-in `viewer` completed for this connection. Reading
 * it takes nothing: a save takes it with `claimOAuthLogin` before writing.
 */
export async function completedOAuthLogin(id: string, viewer: ConnectionViewer, owner: string | null, connectionId?: string, provider: OAuthProvider = 'grok-subscription'): Promise<CompletedOAuthLogin> {
  const entry = await readLogin(id, viewer)
  const login = entry.value
  if (login.provider.provider !== provider || login.ownerId !== owner || login.connectionId !== (connectionId || undefined) || login.status.state !== 'completed') {
    throw new Error('Complete sign-in for this connection first')
  }
  return { id, entry, credential: login.status.credential }
}

/** A save's hold on a sign-in's credential. */
export interface OAuthLoginClaim {
  readonly id: string
  readonly entry: Entry<OAuthLogin>
}

/**
 * Takes the credential for one save, right before it is written to the
 * connection: the sign-in becomes `saving` while it is still what
 * `completedOAuthLogin` read. So of two saves only one writes it, and a save
 * after a cancel, the expiry or another save is refused.
 */
export async function claimOAuthLogin(login: CompletedOAuthLogin): Promise<OAuthLoginClaim> {
  const claimed = await writeLogin(login.id, login.entry, {
    ...login.entry.value, status: { state: 'saving', credential: login.credential }, writeId: randomUUID(),
  })
  if (!claimed) throw new Error(EXPIRED)
  return { id: login.id, entry: claimed }
}

/** The save did not write the credential: it is the sign-in's again, for another save. */
export async function releaseOAuthLoginClaim(claim: OAuthLoginClaim): Promise<void> {
  const { status } = claim.entry.value
  if (status.state !== 'saving') return
  try {
    await writeLogin(claim.id, claim.entry, { ...claim.entry.value, status: { state: 'completed', credential: status.credential }, writeId: randomUUID() })
  } catch (error) {
    console.warn('[llm-oauth] Could not hand a sign-in back after a failed save; it cannot be saved again:', error)
  }
}

/**
 * The save wrote the credential to its connection: the sign-in is removed,
 * and its place freed. A removal whose answer was lost is tried again; one
 * that never lands leaves the sign-in `saving`, which no save takes again.
 */
export async function consumeOAuthLogin(claim: OAuthLoginClaim): Promise<void> {
  try {
    await retryingLostAnswers(() => appState().consume(logins.key(claim.id), { revision: claim.entry.revision }))
  } catch (error) {
    console.warn('[llm-oauth] Could not remove a saved sign-in; it expires with its device code:', error)
  }
  await freePlace(claim.id)
}

/**
 * Ends a sign-in `viewer` started, and frees its place. False when there was
 * nothing this viewer may cancel: no such sign-in, an expired one, someone
 * else's, or one a save has already taken. A poll's answer that arrives
 * afterwards is dropped.
 */
export async function cancelOAuthLogin(id: string, viewer: ConnectionViewer): Promise<boolean> {
  if (!loginIdSchema.safeParse(id).success) return false
  const key = logins.key(id)
  let seen = await appState().get(key)
  for (let attempt = 0; attempt < CANCEL_ATTEMPTS; attempt++) {
    if (!seen || seen.value.expiresAt <= Date.now() || !mayUse(seen.value, viewer) || seen.value.status.state === 'saving') return false
    let removal
    try {
      removal = await appState().consume(key, { revision: seen.revision })
    } catch (error) {
      // The removal may have landed with its answer lost: the place is freed as if it had.
      await freePlace(id)
      throw error
    }
    if (removal.consumed) {
      await freePlace(id)
      return true
    }
    // A poll wrote meanwhile: decided again from what it wrote.
    seen = removal.current
  }
  throw new Error('Sign-in changed while cancelling. Please retry.')
}
