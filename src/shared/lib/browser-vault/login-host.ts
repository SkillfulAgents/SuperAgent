import { z } from 'zod'
import { agentRegistry } from '@shared/lib/agent-actor'
import type { LoginDecision, LoginRequestCall } from '@shared/lib/agent-actor/host-port'
import { isOwnOrigin } from '@shared/lib/auth/own-origin'
import {
  loginContextSchema,
  loginFillResultSchema,
  type LoginContext,
  type LoginFieldKind,
  type LoginFillResult,
  type LoginVaultPayload,
} from '@shared/lib/tools/request-login/login-request'
import { logAuditEvent } from '@shared/lib/services/audit-log-service'
import { heldLoginFor, releaseHeldValues, rememberSignInIdentity, type HeldLogin } from './held-values'
import { providerName } from './providers'
import { siteOfOrigin, usernameKey, vaultFillsInto } from './site'
import {
  findGrantedAccount,
  listGrantedAccounts,
  markAccountRejected,
  readAccountValues,
  recentPasswordFills,
  recordAccountUse,
  saveAccount,
  type VaultAccount,
} from './vault-service'
import { partKeyOf } from './vault-schemas'

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
}

/**
 * Hand the values to the container, which writes them into the page (re-
 * checking the origin in the page) and answers the agent's parked call.
 * On success the request is settled here too; on failure it stays open.
 */
export async function fillLoginInContainer(
  agentSlug: string,
  sessionId: string,
  toolUseId: string,
  context: LoginContext,
  values: string[],
  account?: FillAccountNote,
): Promise<{ ok: true; result: LoginFillResult } | { ok: false; status: 409 | 502; error: string; browserClosed?: true }> {
  const actor = agentRegistry.get(agentSlug)
  const response = await actor.container.fetch('/browser/login/fill', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, toolUseId, expectedOrigin: context.origin, values, ...(account ? { account } : {}) }),
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
  await actor.inputs.complete(sessionId, toolUseId, 'answered')
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
  return {
    username: account.username,
    label: account.label,
    parts: account.parts,
    via: account.via ? { site: account.via.site, username: account.via.username, name: providerName(account.via.site) } : null,
    ...(account.rejectedAt ? { rejected: true } : {}),
  }
}

/**
 * The value for each located field, from a username and saved parts; '' for
 * a field they do not cover (a code, a field never saved).
 */
export function valuesFor(
  fields: ReadonlyArray<{ kind: LoginFieldKind; label: string }>,
  username: string | null,
  parts: Record<string, string>,
): string[] {
  return fields.map((field) => {
    if (field.kind === 'username') return username ?? ''
    const part = partKeyOf(field)
    return part ? parts[part] ?? '' : ''
  })
}

/** The username to name in the agent's result: the container takes up to 320 characters. */
export function noteUsername(username: string | null | undefined): string | undefined {
  return username && username.length <= 320 ? username : undefined
}

/** A held step, when its values may go into this page (as a saved account's would). */
export function usableHeld(held: HeldLogin | null, pageOrigin: string): HeldLogin | null {
  return held && vaultFillsInto(held.origin, pageOrigin) ? held : null
}

/**
 * After held parts went into the page: forget them and, when the user asked
 * to save them, add them to the account — only one that still exists, is
 * theirs, and this agent may still use: the user may have deleted or revoked
 * it since, and that is not undone from memory.
 */
export async function settleHeldParts(input: {
  agentSlug: string
  sessionId: string
  site: string
  held: HeldLogin
  used: string[]
  username: string | null
}): Promise<void> {
  const { agentSlug, sessionId, site, held, used, username } = input
  if (used.length === 0) return
  releaseHeldValues(agentSlug, sessionId, site, used)
  if (!held.save || !username) return
  const owner = held.save.owner
  try {
    // The saver's own: another member may have the same username granted to this agent.
    const key = usernameKey(username)
    const account = (await listGrantedAccounts(agentSlug, site))
      .find((candidate) => usernameKey(candidate.username) === key && (candidate.ownerId ?? null) === (owner ?? null))
    if (!account) return
    const values = Object.fromEntries(used.map((part) => [part, held.values[part]]))
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
 *   account lacks opens the form for just that.
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
  if (!site || isOwnOrigin(context.origin, [])) return ask({ mode: 'new' }, context)
  if (askUser) {
    const turnedDown = username ? await findGrantedAccount(agentSlug, site, username) : null
    // Only a step that asks for the password can have turned it down: not a wrong code.
    const asksPassword = context.fields.some((field) => field.kind === 'password')
    if (asksPassword && turnedDown?.parts.includes('password')) await markAccountRejected({ agentSlug, accountId: turnedDown.id, sessionId })
    return ask({ mode: 'ask', ...(username ? { username: turnedDown?.username ?? username } : {}), ...(reason ? { reason } : {}) }, context)
  }

  const held = usableHeld(heldLoginFor(agentSlug, sessionId, site, username), context.origin)
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

  // An account that signs in through another one: the user has nothing to
  // type here, even where the page also shows a password form, unless the
  // step asks only for what it holds besides (a workspace), or for a code:
  // the site's own check after the provider's, which the user answers. The
  // agent is told which provider account to use.
  const asksCode = context.fields.some((field) => field.kind === 'otp')
  if (account?.via && !asksCode && !fillsWithoutPassword(account, context.fields)) {
    const via = { site: account.via.site, username: account.via.username, name: providerName(account.via.site) }
    if (await answerLoginRequest(agentSlug, toolUseId, { type: 'via', site, username: account.username, provider: via, saved: true })) {
      await recordAccountUse({ agentSlug, accountId: account.id, sessionId, password: false, by: 'vault' })
      return { action: 'settled' }
    }
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
  const saved = account && vaultFillsInto(account.origin, context.origin) ? await readAccountValues(account.id) : {}
  const parts = { ...saved, ...(held?.values ?? {}) }
  const values = valuesFor(context.fields, identity, parts)
  const covered = values.flatMap((value, index) => (value ? [index] : []))
  if (covered.length < values.length) {
    return ask({ mode: 'complete', ...(identity ? { username: identity } : {}), ...(account ? { accountId: account.id } : {}), covered }, context)
  }

  const fromHeld = Object.keys(held?.values ?? {}).filter((part) => context.fields.some((field) => partKeyOf(field) === part))
  const shown = noteUsername(identity)
  const filled = await fillLoginInContainer(agentSlug, sessionId, toolUseId, context, values, {
    ...(shown ? { username: shown } : {}),
    site,
    source: account && fromHeld.length === 0 ? 'vault' : 'user',
    saved: false,
    held: [],
  })
  // The browser closed first: there is nothing for the user to answer. The
  // account, or what was held, signs the agent in once it opens the page again.
  if (!filled.ok && filled.browserClosed) {
    const kept = account ? { how: 'vault' as const, username: account.username } : { how: 'held' as const, ...(shown ? { username: shown } : {}) }
    if (await answerLoginRequest(agentSlug, toolUseId, { type: 'browser_closed', site, kept })) return { action: 'settled' }
  }
  // The page or the browser refused: the user can still answer the form.
  if (!filled.ok) return ask({ mode: 'complete', ...(identity ? { username: identity } : {}), ...(account ? { accountId: account.id } : {}), covered }, context)

  if (identity) rememberSignInIdentity(agentSlug, sessionId, site, identity)
  // Only what went into the page counts: the browser may have written none of it.
  const wentIn = fieldsWentIn(filled.result, context.fields.length)
  // Saved once filled: the step it was for did come.
  const usedHeld = fromHeld.filter((part) => context.fields.some((field, index) => partKeyOf(field) === part && wentIn[index]))
  if (held) await settleHeldParts({ agentSlug, sessionId, site, held, used: usedHeld, username: identity })
  // Saved or held for this step: either way the account's password was tried
  // (filledTooOften counts it); held, the user had just entered it.
  if (account && wentIn.some(Boolean)) {
    const password = context.fields.some((field, index) => field.kind === 'password' && wentIn[index])
    await recordAccountUse({ agentSlug, accountId: account.id, sessionId, password, by: fromHeld.includes('password') ? 'user' : 'vault' })
  }
  return { action: 'settled' }
}
