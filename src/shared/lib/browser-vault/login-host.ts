import { z } from 'zod'
import { agentRegistry } from '@shared/lib/agent-actor'
import type { LoginDecision, LoginRequestCall } from '@shared/lib/agent-actor/host-port'
import { isOwnOrigin } from '@shared/lib/auth/own-origin'
import {
  loginContextSchema,
  loginFillResultSchema,
  type CodeSource,
  type LoginContext,
  type LoginFieldKind,
  type LoginFillResult,
  type LoginVaultPayload,
} from '@shared/lib/tools/request-login/login-request'
import { background } from '@shared/lib/background'
import { logAuditEvent } from '@shared/lib/services/audit-log-service'
import { claimHeldParts, heldLoginFor, recentSignInIdentity, rememberSignInIdentity, settleHeldClaim, type HeldClaim, type HeldLoginRead } from './held-values'
import { askForSignInMethod } from './method-request'
import { providerName } from './providers'
import { beginSignInStep, restoreSavedSession, sessionBaseline, watchSignIn } from './session-host'
import { siteOfOrigin, usernameKey, vaultFillsInto } from './site'
import { freshTotpCode } from './totp'
import {
  findGrantedAccount,
  listGrantedAccounts,
  markAccountRejected,
  markAuthenticatorRejected,
  passkeyWorksOn,
  readAccountFill,
  readAccountPasskeys,
  recentPasswordFills,
  recordAccountUse,
  saveAccount,
  type VaultAccount,
} from './vault-service'
import { fillKeyOf, partKeyOf, TOTP_FILL_KEY } from './vault-schemas'

/**
 * The host's side of request_login. The agent maps a page's sign-in fields;
 * the container locates them; the host then answers the call from the
 * user's vault when it can (the agent's saved accounts on the site, or one
 * of them filled straight into the page) and leaves it to the user's form
 * when it cannot. Values only ever go to the container's fill endpoint,
 * which writes them into the frame it located — never to the agent.
 */

const loginContextErrorSchema = z.object({
  error: z.string().optional(),
  problems: z.array(z.string()).optional(),
})
const containerErrorSchema = z.object({ error: z.string(), reason: z.string().optional() })

export type LoginContextRead =
  | { ok: true; context: LoginContext }
  | { ok: false; status: 404 | 409 | 502; error: string; problems: string[] }

/**
 * The sign-in form's context as the browser reported it when it located the
 * fields: kept on the request once read, and read from the container again
 * when the request does not hold it (a request recovered after a restart).
 * 404 means still locating — the app tries again; 409 means the container
 * said the fields the agent picked could not be used (its tool returned
 * that); 502, anything else (the container unreachable or refusing the host).
 */
export async function readLoginContext(agentSlug: string, toolUseId: string): Promise<LoginContextRead> {
  const actor = agentRegistry.get(agentSlug)
  const request = await actor.inputs.get(toolUseId)
  const cached = loginContextSchema.safeParse(request?.kind === 'login' ? request.payload.login : undefined)
  if (cached.success) return { ok: true, context: cached.data }
  try {
    // The container answers once the agent's tool has located the fields.
    const response = await actor.container.fetch(`/browser/login/context?toolUseId=${encodeURIComponent(toolUseId)}`)
    const data: unknown = await response.json().catch(() => null)
    if (!response.ok) {
      const failure = loginContextErrorSchema.safeParse(data)
      const problems = failure.success ? failure.data.problems ?? [] : []
      if (response.status === 404) return { ok: false, status: 404, error: 'The sign-in form is still being located', problems }
      if (response.status === 409 && failure.success && failure.data.problems) {
        return { ok: false, status: 409, error: 'The browser could not locate the sign-in fields', problems }
      }
      console.error(`[login-request] Reading the sign-in form failed: HTTP ${response.status}`)
      return { ok: false, status: 502, error: 'The browser is unavailable', problems: [] }
    }
    const context = loginContextSchema.safeParse(data)
    if (!context.success) return { ok: false, status: 502, error: 'The browser returned an unreadable sign-in form', problems: [] }
    await actor.inputs.enrich(toolUseId, 'login', { login: context.data })
    return { ok: true, context: context.data }
  } catch (error) {
    console.error('[login-request] Reading the sign-in form failed:', error instanceof Error ? error.message : error)
    return { ok: false, status: 502, error: 'The browser is unavailable', problems: [] }
  }
}

/** Where the values came from, for the agent's result (the container's `account`). */
export interface FillAccountNote {
  username?: string
  site: string
  source: 'user' | 'vault'
  saved: boolean
  held: string[]
  /** The vault holds an authenticator app for the account (named so on the site, when it asked): a later step's code needs no one. */
  authenticator?: { name?: string }
}

/** Whether the vault makes the account's authenticator codes: it holds an app the site has not rejected. */
export function authenticatorReady(account: Pick<VaultAccount, 'signInMethods'>): boolean {
  const authenticator = account.signInMethods.authenticator
  return authenticator !== undefined && !authenticator.rejectedAt
}

/** What the agent is told about the account's sign-in methods with a fill's result. */
export function methodNotes(account: Pick<VaultAccount, 'signInMethods'> | null): Pick<FillAccountNote, 'authenticator'> {
  if (!account || !authenticatorReady(account)) return {}
  const name = account.signInMethods.authenticator?.name
  return { authenticator: name ? { name } : {} }
}

/**
 * The owner asked for a sign-in method on the account: the agent signing in
 * with it is asked, as the owner's message, once per session (method-request).
 */
export function askForRequestedMethod(agentSlug: string, sessionId: string, account: VaultAccount): void {
  const requested = account.signInMethods.requested
  if (!requested || requested.askedIn === sessionId) return
  background(askForSignInMethod({ agentSlug, sessionId, account, from: requested.from }), { name: 'browser-vault.ask-for-sign-in-method' })
}

/**
 * Hand the values to the container, which writes them into the page (re-
 * checking the origin in the page) and answers the agent's parked call.
 * On success the request is settled here too; on failure it stays open.
 * `answer: false`: the caller answers the call itself (a host tool's), and
 * the result carries the container's report of the fill for it.
 */
export async function fillLoginInContainer(
  agentSlug: string,
  sessionId: string,
  toolUseId: string,
  context: Pick<LoginContext, 'origin'>,
  values: string[],
  account?: FillAccountNote,
  options: { answer?: false } = {},
): Promise<{ ok: true; result: LoginFillResult } | { ok: false; status: 409 | 502; error: string; browserClosed?: true }> {
  const actor = agentRegistry.get(agentSlug)
  const response = await actor.container.fetch('/browser/login/fill', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      toolUseId,
      expectedOrigin: context.origin,
      values,
      ...(account ? { account } : {}),
      ...(options.answer === false ? { answer: false } : {}),
    }),
  })
  const data: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const failure = containerErrorSchema.safeParse(data)
    return {
      ok: false,
      status: response.status === 409 ? 409 : 502,
      error: failure.success ? failure.data.error : 'The sign-in form could not be filled',
      // The browser that showed the form closed since: the request is still open.
      ...(response.status === 409 && failure.success && failure.data.reason === 'browser_closed' ? { browserClosed: true as const } : {}),
    }
  }
  const result = loginFillResultSchema.safeParse(data)
  if (!result.success) return { ok: false, status: 502, error: 'The browser returned an unreadable result' }
  if (options.answer !== false) await actor.inputs.complete(sessionId, toolUseId, 'answered')
  return { ok: true, result: result.data }
}

/**
 * Which located fields may hold their value after a fill: written, written and
 * changed by the page, or sent without an answer (the page may have taken it,
 * and submitted). Only a field the browser could not write at all (a stale
 * ref, a disabled input) is known not to: nothing was tried with it, and what
 * was held for it is still there for the agent's next try. Without outcomes,
 * every field counts.
 */
export function fieldsWentIn(result: LoginFillResult, count: number): boolean[] {
  const { outcomes } = result
  return Array.from({ length: count }, (_, index) => !outcomes || (outcomes[index] !== 'failed' && outcomes[index] !== 'skipped'))
}

/** Answer the agent's parked call with a result that fills nothing (its accounts, or a provider account to use). */
export async function answerLoginRequest(agentSlug: string, toolUseId: string, resolution: Record<string, unknown>): Promise<boolean> {
  const response = await agentRegistry.get(agentSlug).container.fetch(`/inputs/${encodeURIComponent(toolUseId)}/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: JSON.stringify(resolution) }),
  })
  return response.ok
}

/** A saved account as the agent may see it: never a value. */
export function accountView(account: VaultAccount) {
  const authenticator = account.signInMethods.authenticator
  return {
    username: account.username,
    label: account.label,
    parts: account.parts,
    via: account.via ? { site: account.via.site, username: account.via.username, name: providerName(account.via.site) } : null,
    ...(account.rejectedAt ? { rejected: true } : {}),
    ...(authenticator ? { authenticator: authenticator.rejectedAt ? 'rejected' as const : 'ready' as const } : {}),
    ...(authenticator?.name ? { authenticatorName: authenticator.name } : {}),
    ...(account.signInMethods.passkeys?.length ? { passkeys: account.signInMethods.passkeys.length } : {}),
  }
}

/**
 * The value for each located field, from a username and saved parts (with
 * `totp`, the authenticator app's current code); '' for a field they do not
 * cover (a code sent to the user, a field never saved).
 */
export function valuesFor(
  fields: ReadonlyArray<{ kind: LoginFieldKind; label: string; from?: CodeSource }>,
  username: string | null,
  parts: Record<string, string>,
): string[] {
  return fields.map((field) => {
    if (field.kind === 'username') return username ?? ''
    const key = fillKeyOf(field)
    return key ? parts[key] ?? '' : ''
  })
}

/** The username to name in the agent's result: the container takes up to 320 characters. */
export function noteUsername(username: string | null | undefined): string | undefined {
  return username && username.length <= 320 ? username : undefined
}

/** A held step, when its values may go into this page (as a saved account's would). */
export function usableHeld(held: HeldLoginRead | null, pageOrigin: string): HeldLoginRead | null {
  return held && vaultFillsInto(held.origin, pageOrigin) ? held : null
}

/**
 * After held parts went into the page (their claim settled): when the user
 * asked to save them, add them to the account — only one that still exists,
 * is theirs, and this agent may still use: the user may have deleted or
 * revoked it since, and that is not undone from what was held.
 */
export async function saveHeldParts(input: {
  claim: HeldClaim
  held: HeldLoginRead
  used: string[]
  username: string | null
}): Promise<void> {
  const { claim, held, used, username } = input
  const { agentSlug, site } = claim
  if (used.length === 0 || !held.save || !username) return
  const owner = held.save.owner
  try {
    // The saver's own: another member may have the same username granted to this agent.
    const key = usernameKey(username)
    const account = (await listGrantedAccounts(agentSlug, site))
      .find((candidate) => usernameKey(candidate.username) === key && (candidate.ownerId ?? null) === (owner ?? null))
    if (!account) return
    const values = Object.fromEntries(used.map((part) => [part, claim.values[part]]))
    await saveAccount({ owner, site, origin: held.origin, username: account.username, values })
    await logAuditEvent({ userId: owner, object: 'browser_account', objectId: account.id, action: 'updated', details: { site } })
  } catch (error) {
    console.error('[login-request] Saving the held parts failed:', error instanceof Error ? error.message : error)
  }
}

/** Part keys and values for the fields given, skipping empty ones and what is not a part. */
export function partsFrom(fields: ReadonlyArray<{ kind: LoginFieldKind; label: string }>, values: readonly string[]): Record<string, string> {
  const parts: Record<string, string> = {}
  fields.forEach((field, index) => {
    const part = partKeyOf(field)
    if (part && values[index]) parts[part] = values[index]
  })
  return parts
}

const toolInputSchema = z.object({
  username: z.string().trim().min(1).max(320).optional().catch(undefined),
  ask_user: z.boolean().optional().catch(undefined),
  reason: z.string().trim().min(1).max(500).optional().catch(undefined),
}).loose()

const HALF_HOUR_MS = 30 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
/** How often the vault fills an account's password without the user within half an hour: one retry after a hiccup. */
const FILLS_PER_HALF_HOUR = 2
/** And within a day: past that, most likely a password the site turns down. */
const FILLS_PER_DAY = 5

/**
 * When the vault last filled the account's password without the user, if it
 * did so too often for another try without them: every attempt with a
 * password the site turns down counts toward its lockout. Counted since the
 * user last signed in with the account themselves (what they entered or
 * picked then is what goes in now), from the audit log: across sessions and
 * agents, and over a restart.
 */
async function filledTooOften(account: VaultAccount, now = Date.now()): Promise<string | null> {
  const fills = await recentPasswordFills(account.id, DAY_MS, now)
  const userSince = fills.findIndex((fill) => !fill.unattended)
  const unattended = userSince < 0 ? fills : fills.slice(0, userSince)
  const lately = unattended.filter((fill) => now - fill.at.getTime() <= HALF_HOUR_MS)
  if (lately.length < FILLS_PER_HALF_HOUR && unattended.length < FILLS_PER_DAY) return null
  return unattended[0].at.toISOString()
}

/** Whether every located field is one this account fills without its password: a step asking only for a workspace. */
function fillsWithoutPassword(account: VaultAccount, fields: LoginContext['fields']): boolean {
  return fields.length > 0 && fields.every((field) => {
    if (field.kind === 'username') return true
    const part = partKeyOf(field)
    return part !== null && part !== 'password' && account.parts.includes(part)
  })
}

/**
 * Whether the page is the first of a sign-in: it asks who is signing in, or
 * offers signing in with another account. Not a password asked again on a
 * page that is signed in ("Confirm access"), nor a later step.
 */
export function isFirstSignInPage(context: Pick<LoginContext, 'fields' | 'providers'>): boolean {
  return context.fields.some((field) => field.kind === 'username') || context.providers.length > 0
}

/**
 * Whether the session a step leaves is watched as the account's
 * (session-host): from a sign-in's first page, or a later step of the one
 * this session began on the site with the same username. Elsewhere the
 * browser may be signed in as another account (its password asked again,
 * "Confirm access"), which is not this one's to save.
 */
export async function watchesStep(input: {
  agentSlug: string
  sessionId: string
  site: string
  context: Pick<LoginContext, 'fields' | 'providers'>
  username: string | null
}): Promise<boolean> {
  if (isFirstSignInPage(input.context)) return true
  const last = await recentSignInIdentity(input.agentSlug, input.sessionId, input.site)
  return last !== null && input.username !== null && usernameKey(last) === usernameKey(input.username)
}

/**
 * Whether a session saved from an earlier sign-in may sign the account in on
 * this page, in place of its values: a sign-in that has not begun for it (its
 * first page, nothing held for the step, not a code, not this account's step
 * again), and never a session saved on an encrypted page into a plain-HTTP one.
 * The agent naming the account, or the user picking it in the card.
 */
export async function restoresHere(input: {
  agentSlug: string
  sessionId: string
  account: Pick<VaultAccount, 'site' | 'origin' | 'username'>
  context: Pick<LoginContext, 'origin' | 'fields' | 'providers'>
  held: HeldLoginRead | null
}): Promise<boolean> {
  const { agentSlug, sessionId, account, context, held } = input
  if (held || !isFirstSignInPage(context) || context.fields.some((field) => field.kind === 'otp')) return false
  if (!vaultFillsInto(account.origin, context.origin)) return false
  const lastIdentity = await recentSignInIdentity(agentSlug, sessionId, account.site)
  return lastIdentity === null || usernameKey(lastIdentity) !== usernameKey(account.username)
}

/** How long the host waits for the container to locate the fields before leaving the request to the form. */
const LOCATE_WAIT_MS = 45_000

async function locatedContext(agentSlug: string, toolUseId: string): Promise<LoginContextRead> {
  const deadline = Date.now() + LOCATE_WAIT_MS
  for (;;) {
    const read = await readLoginContext(agentSlug, toolUseId)
    if (read.ok || read.status !== 404 || Date.now() >= deadline) return read
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

function ask(vault: LoginVaultPayload, context?: LoginContext): LoginDecision {
  return { action: 'ask', vault, ...(context ? { login: context } : {}) }
}

/**
 * Decide a request_login call before any card is shown: answer it from the
 * vault, or leave it to the user. A request the vault answers never reaches
 * the user, so an agent with a saved account signs in on a schedule without
 * anyone being asked or notified.
 *
 * - No username: the agent's saved accounts on the site are listed (nothing
 *   is filled), or the form opens when it has none.
 * - A username: that account's parts (and what the user entered earlier for
 *   this step) fill the mapped fields, and the page is submitted. What the
 *   account lacks opens the form for just that. On a sign-in's first page,
 *   a session saved from an earlier one goes in first, when the agent's
 *   browser has not had it (session-host): nothing is filled then. Each
 *   step is watched for the session it leaves (session-host).
 * - ask_user (or a reason): always the form. With a username, the agent says
 *   the site turned that account down: the user enters it again, and until
 *   they do the vault does not fill its password without them.
 *
 * A saved password goes in without the user once per session in a while: a
 * second sign-in with it so soon is most often the site rejecting it, and
 * every unattended retry spends an attempt toward a lockout.
 */
export async function decideLoginRequest(call: LoginRequestCall): Promise<LoginDecision> {
  const { agentSlug, sessionId, toolUseId } = call
  let parsedInput: unknown = {}
  try {
    parsedInput = JSON.parse(call.input)
  } catch {
    // The model's input: the card reports what it can.
  }
  const input = toolInputSchema.safeParse(parsedInput)
  const username = input.success ? input.data.username : undefined
  const reason = input.success ? input.data.reason : undefined
  const askUser = (input.success && input.data.ask_user === true) || reason !== undefined

  const read = await locatedContext(agentSlug, toolUseId)
  // The fields could not be used: the tool already said why, and the call is over.
  if (!read.ok) return read.status === 409 ? { action: 'none' } : ask({ mode: 'new' })
  const context = read.context
  const site = siteOfOrigin(context.origin)
  // This app's own page: the card says nothing can go there.
  if (!site || (await isOwnOrigin(context.origin, []))) return ask({ mode: 'new' }, context)
  if (askUser) {
    const turnedDown = username ? await findGrantedAccount(agentSlug, site, username) : null
    // A step that asks for the password turned the password down; one that
    // asks for the authenticator app's code, the app the vault holds. Not a
    // code the site sent the user.
    const asksPassword = context.fields.some((field) => field.kind === 'password')
    if (asksPassword && turnedDown?.parts.includes('password')) await markAccountRejected({ agentSlug, accountId: turnedDown.id, sessionId })
    if (asksAuthenticatorCode(context) && turnedDown && authenticatorReady(turnedDown)) {
      await markAuthenticatorRejected({ agentSlug, accountId: turnedDown.id, sessionId })
    }
    return ask({ mode: 'ask', ...(username ? { username: turnedDown?.username ?? username } : {}), ...(reason ? { reason } : {}) }, context)
  }

  // Decided again when what was held for this step is taken by another fill
  // while this one decides: then without it.
  for (let attempt = 0; attempt < HELD_DECISION_ATTEMPTS; attempt++) {
    const decision = await decideFromVault(call, context, site, username)
    if (decision) return decision
  }
  return ask({ mode: 'new' }, context)
}

/** How often a decision starts over after what was held for its step was taken under it. */
const HELD_DECISION_ATTEMPTS = 3

/** How long the agent's tab holds an account's passkey for a sign-in. */
const PASSKEY_SIGN_IN_MS = 5 * 60 * 1000

const passkeyStateSchema = z.object({ armed: z.boolean(), onActiveTab: z.boolean(), credentialIds: z.array(z.string()) })

/** The page's hostname, or '' for an origin that does not parse. */
export function hostnameOf(origin: string): string {
  try {
    return new URL(origin).hostname
  } catch {
    return ''
  }
}

/** Whether the vault holds a passkey of the account that works on this page (plain record: no key read). */
function hasPasskeyFor(account: Pick<VaultAccount, 'signInMethods'>, origin: string): boolean {
  const hostname = hostnameOf(origin)
  return Boolean(hostname) && (account.signInMethods.passkeys ?? []).some((held) => passkeyWorksOn(held.rpId, hostname))
}

/**
 * Hold the account's passkeys for this page on the agent's tab, for the
 * sign-in. Null when the tab holds them already (the sign-in goes on) or they
 * could not be held (it goes on as it would without them). A tab the agent
 * went on in (a window the site opened) gets them in turn. A sign-in step for
 * the account: the session it leaves is watched as its (session-host).
 */
async function offerPasskey(input: {
  agentSlug: string
  sessionId: string
  account: VaultAccount
  context: LoginContext
  site: string
}): Promise<{ name: string | null } | null> {
  const { agentSlug, sessionId, account, context, site } = input
  const passkeys = await readAccountPasskeys(account.id, hostnameOf(context.origin))
  if (passkeys.length === 0) return null
  const container = agentRegistry.get(agentSlug).container
  try {
    const state = passkeyStateSchema.safeParse(await (await container.fetch('/browser/passkey/state')).json().catch(() => null))
    if (state.success && state.data.armed && state.data.onActiveTab && passkeys.some((held) => state.data.credentialIds.includes(held.credentialId))) return null
    const watched = await watchesStep({ agentSlug, sessionId, site, context, username: account.username })
    beginSignInStep(agentSlug, { site, username: account.username, accountId: account.id })
    const baseline = watched ? await sessionBaseline({ agentSlug, sessionId, scope: account }) : null
    const armed = await container.fetch('/browser/passkey/arm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, mode: 'present', credentials: passkeys, ttlMs: PASSKEY_SIGN_IN_MS }),
    })
    if (!armed.ok) return null
    await rememberSignInIdentity(agentSlug, sessionId, site, account.username)
    await recordAccountUse({ agentSlug, accountId: account.id, sessionId, password: false, by: 'vault', passkey: true })
    watchSignIn({ agentSlug, sessionId, account, baseline })
    askForRequestedMethod(agentSlug, sessionId, account)
  } catch (error) {
    console.error('[login-request] Holding the passkey failed:', error instanceof Error ? error.message : error)
    return null
  }
  const listed = account.signInMethods.passkeys?.find((held) => passkeys.some((key) => key.credentialId === held.credentialId))
  return { name: listed?.name ?? null }
}

/** Whether the step asks for the code of an authenticator app (as the agent mapped it). */
function asksAuthenticatorCode(context: Pick<LoginContext, 'fields'>): boolean {
  return context.fields.some((field) => fillKeyOf(field) === TOTP_FILL_KEY)
}

/** How many codes the vault's authenticator app fills by itself within half an hour, and within a day. */
const CODES_PER_HALF_HOUR = 3
const CODES_PER_DAY = 10

/**
 * Whether the vault filled the account's authenticator codes too often for
 * another without the user: a site that turns its codes down (an app removed
 * there since) counts each one toward its lockout.
 */
async function codesFilledTooOften(account: VaultAccount, now = Date.now()): Promise<boolean> {
  const fills = await recentPasswordFills(account.id, DAY_MS, now, 'code')
  const lately = fills.filter((fill) => now - fill.at.getTime() <= HALF_HOUR_MS)
  return lately.length >= CODES_PER_HALF_HOUR || fills.length >= CODES_PER_DAY
}

/**
 * The vault's answer to a call that names an account or follows a held step.
 * Null when the held parts it was to fill were taken (by another fill), used
 * or forgotten after it read them: nothing was sent, and the caller decides again.
 */
async function decideFromVault(call: LoginRequestCall, context: LoginContext, site: string, username: string | undefined): Promise<LoginDecision | null> {
  const { agentSlug, sessionId, toolUseId } = call
  const held = usableHeld(await heldLoginFor(agentSlug, sessionId, site, username), context.origin)
  if (!username && !held) {
    const granted = await listGrantedAccounts(agentSlug, site)
    if (granted.length === 0) return ask({ mode: 'new' }, context)
    const answered = await answerLoginRequest(agentSlug, toolUseId, { type: 'accounts', site, accounts: granted.map(accountView) })
    return answered ? { action: 'settled' } : ask({ mode: 'new' }, context)
  }

  // The held step names its account when the agent did not: its saved parts fill the rest.
  const named = username ?? held?.username ?? undefined
  const account = named ? await findGrantedAccount(agentSlug, site, named) : null
  // An account the agent may not use (or that does not exist): the user decides.
  if (username && !account && !held) return ask({ mode: 'ask', username }, context)
  const identity = account?.username ?? username ?? held?.username ?? null
  const asksCode = context.fields.some((field) => field.kind === 'otp')
  const firstPage = isFirstSignInPage(context)

  // A sign-in that has not begun for this account: a session saved from an
  // earlier one may sign the agent in with nothing filled.
  if (username && account && await restoresHere({ agentSlug, sessionId, account, context, held })) {
    const restored = await restoreSavedSession({ agentSlug, sessionId, account })
    if (restored) {
      if (restored.restored) askForRequestedMethod(agentSlug, sessionId, account)
      if (await answerLoginRequest(agentSlug, toolUseId, restored)) return { action: 'settled' }
      return ask({ mode: 'ask', username: account.username }, context)
    }
  }

  // A passkey the vault holds for the account on this site: held on the
  // agent's tab for the rest of the sign-in (passkey-keeper), and the agent
  // is told to use the page's passkey option, with nothing filled. Its next
  // call (a page with no passkey option, or one that asks who first) goes on
  // as usual, the passkey still there for a prompt further on.
  if (username && account && hasPasskeyFor(account, context.origin)) {
    const offered = await offerPasskey({ agentSlug, sessionId, account, context, site })
    if (offered) {
      const passkey = { type: 'passkey', site, username: account.username, ...(offered.name ? { name: offered.name } : {}) }
      if (await answerLoginRequest(agentSlug, toolUseId, passkey)) return { action: 'settled' }
      return ask({ mode: 'ask', username: account.username }, context)
    }
  }

  // An account that signs in through another one: the user has nothing to
  // type here, even where the page also shows a password form, unless the
  // step asks only for what it holds besides (a workspace), or for a code:
  // the site's own check after the provider's, which the user answers. The
  // agent is told which provider account to use.
  if (account?.via && !asksCode && !fillsWithoutPassword(account, context.fields)) {
    const via = { site: account.via.site, username: account.via.username, name: providerName(account.via.site) }
    beginSignInStep(agentSlug, { site: account.site, username: account.username, accountId: account.id })
    // Watched only from a sign-in's first page: elsewhere the browser may be
    // signed in as another account, which is not this one's to save.
    const baseline = firstPage ? await sessionBaseline({ agentSlug, sessionId, scope: account }) : null
    if (await answerLoginRequest(agentSlug, toolUseId, { type: 'via', site, username: account.username, provider: via, saved: true })) {
      await recordAccountUse({ agentSlug, accountId: account.id, sessionId, password: false, by: 'vault' })
      // The site's own session, once the provider sends the agent back signed in.
      watchSignIn({ agentSlug, sessionId, account, baseline })
      return { action: 'settled' }
    }
    return ask({ mode: 'ask', username: account.username }, context)
  }
  // A code the agent did not say the source of, for an account whose
  // authenticator app the vault holds: it is told the vault fills that one,
  // rather than the user being asked for a code they may not have.
  if (account && authenticatorReady(account) && context.fields.some((field) => field.kind === 'otp' && !field.from)) {
    if (await answerLoginRequest(agentSlug, toolUseId, { type: 'authenticator', site, username: account.username })) return { action: 'settled' }
    return ask({ mode: 'ask', username: account.username }, context)
  }
  if (context.fields.length === 0) {
    // Named, but no field mapped to fill: say so, rather than list it back.
    const listed = account && await answerLoginRequest(agentSlug, toolUseId, { type: 'accounts', site, accounts: [accountView(account)], named: true })
    return listed ? { action: 'settled' } : ask({ mode: 'ask', ...(identity ? { username: identity } : {}) }, context)
  }

  // Its saved password, when the page asks for one the user did not enter
  // for this step: not while the site has turned it down, nor twice in a while.
  const savedPassword = account !== null && account.parts.includes('password') && !held?.values.password &&
    context.fields.some((field) => field.kind === 'password')
  if (account && savedPassword) {
    if (account.rejectedAt) return ask({ mode: 'ask', username: account.username, rejectedAt: account.rejectedAt.toISOString() }, context)
    const filledAt = await filledTooOften(account)
    if (filledAt) return ask({ mode: 'ask', username: account.username, filledAt }, context)
  }

  // A secret first typed on an encrypted page does not go to a plain-HTTP one unasked.
  const fill = account && vaultFillsInto(account.origin, context.origin) ? await readAccountFill(account.id) : null
  const saved = fill?.values ?? {}
  // The authenticator app's code, when the step asks for one: made just
  // before the fill (below), so here only whether it can be.
  const totp = fill?.totp && account && asksAuthenticatorCode(context) && !(await codesFilledTooOften(account)) ? fill.totp : null
  const fillable = totp ? { ...saved, [TOTP_FILL_KEY]: 'made at the fill' } : saved
  const covered = valuesFor(context.fields, identity, { ...fillable, ...(held?.values ?? {}) }).flatMap((value, index) => (value ? [index] : []))
  if (covered.length < context.fields.length) {
    return ask({ mode: 'complete', ...(identity ? { username: identity } : {}), ...(account ? { accountId: account.id } : {}), covered }, context)
  }

  // What was held goes into one page only: this fill takes it before sending it.
  const fromHeld = Object.keys(held?.values ?? {}).filter((part) => context.fields.some((field) => partKeyOf(field) === part))
  let claim: HeldClaim | null = null
  if (held && fromHeld.length > 0) {
    claim = await claimHeldParts(agentSlug, sessionId, site, held, fromHeld)
    if (!claim) return null
  }
  const shown = noteUsername(identity)
  // Nothing watched before the step watches what it leaves; the site as it is
  // before the step is what the watch after it compares with.
  const watched = account !== null && await watchesStep({ agentSlug, sessionId, site, context, username: identity })
  beginSignInStep(agentSlug, { site, username: identity, accountId: account?.id ?? null })
  const baseline = watched ? await sessionBaseline({ agentSlug, sessionId, scope: account }) : null
  // Made last, so it has most of its period left when the page sends it.
  const code = totp ? await freshTotpCode(totp) : null
  const values = valuesFor(context.fields, identity, { ...saved, ...(claim?.values ?? {}), ...(code ? { [TOTP_FILL_KEY]: code } : {}) })
  let filled: Awaited<ReturnType<typeof fillLoginInContainer>>
  try {
    filled = await fillLoginInContainer(agentSlug, sessionId, toolUseId, context, values, {
      ...(shown ? { username: shown } : {}),
      site,
      source: account && fromHeld.length === 0 ? 'vault' : 'user',
      saved: false,
      held: [],
      ...methodNotes(account),
    })
  } catch (error) {
    // No answer: the values may be in the page, so what was held for it is used.
    if (claim) await settleHeldClaim(claim, fromHeld)
    throw error
  }
  // The page or the browser refused: nothing went in, and what was held is there for the next try.
  if (!filled.ok && claim) await settleHeldClaim(claim, [])
  // The browser closed first: there is nothing for the user to answer. The
  // account, or what was held, signs the agent in once it opens the page again.
  if (!filled.ok && filled.browserClosed) {
    const kept = account ? { how: 'vault' as const, username: account.username } : { how: 'held' as const, ...(shown ? { username: shown } : {}) }
    if (await answerLoginRequest(agentSlug, toolUseId, { type: 'browser_closed', site, kept })) return { action: 'settled' }
  }
  // The page or the browser refused: the user can still answer the form.
  if (!filled.ok) return ask({ mode: 'complete', ...(identity ? { username: identity } : {}), ...(account ? { accountId: account.id } : {}), covered }, context)

  // Only what went into the page counts: the browser may have written none of it.
  const wentIn = fieldsWentIn(filled.result, context.fields.length)
  // What went in is used; a held part the browser could not write is there for the next try.
  const usedHeld = fromHeld.filter((part) => context.fields.some((field, index) => partKeyOf(field) === part && wentIn[index]))
  if (claim) await settleHeldClaim(claim, usedHeld)
  // Saved once filled: the step it was for did come.
  if (claim && held) await saveHeldParts({ claim, held, used: usedHeld, username: identity })
  if (identity) await rememberSignInIdentity(agentSlug, sessionId, site, identity)
  // Saved or held for this step: either way the account's password was tried
  // (filledTooOften counts it); held, the user had just entered it.
  if (account && wentIn.some(Boolean)) {
    const password = context.fields.some((field, index) => field.kind === 'password' && wentIn[index])
    // Counted toward how often the vault fills the app's codes by itself.
    const codeWentIn = code !== null && context.fields.some((field, index) => fillKeyOf(field) === TOTP_FILL_KEY && wentIn[index])
    await recordAccountUse({
      agentSlug,
      accountId: account.id,
      sessionId,
      password,
      by: fromHeld.includes('password') ? 'user' : 'vault',
      ...(codeWentIn ? { code: true as const } : {}),
    })
    watchSignIn({ agentSlug, sessionId, account, baseline })
    askForRequestedMethod(agentSlug, sessionId, account)
  }
  return { action: 'settled' }
}
