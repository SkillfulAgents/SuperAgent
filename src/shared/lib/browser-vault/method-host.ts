import { z } from 'zod'
import { agentRegistry } from '@shared/lib/agent-actor'
import type { HostToolRequest, HostToolResult } from '@shared/lib/agent-actor/host-port'
import { isOwnOrigin } from '@shared/lib/auth/own-origin'
import { fieldsWentIn, fillLoginInContainer, hostnameOf, noteUsername } from './login-host'
import { siteOfOrigin } from './site'
import { freshTotpCode, parseTotpSetup } from './totp'
import { passkeySchema } from './vault-schemas'
import { findGrantedAccount, markSignInMethodUnavailable, passkeyWorksOn, saveAuthenticator, savePasskey, VaultConflictError, type VaultAccount } from './vault-service'

/**
 * The host's side of add_sign_in_method: an agent adds a sign-in method to a
 * saved account it may use, when its owner asked for one (the sign-in card's
 * box, a switch in Settings → Logins) or the user asked the agent in the
 * conversation. For an authenticator app, the container locates the field for
 * the code that confirms it and reads the app's setup from the page (a QR
 * code, a link, or a key); the host makes the app's current code, has it
 * filled, and saves the seed only once that code went into the page. The seed
 * and the code never reach the agent.
 *
 * For a passkey, the container holds a recording authenticator on the agent's
 * tab (passkey-keeper) and clicks the site's "Add a passkey"; the passkey the
 * page creates (its private key with it) comes to the host, which seals it
 * into the account. A site that first asks for the password gets it signed in
 * with request_login meanwhile: the tab stays ready a while, and the agent's
 * next call takes what the page created.
 *
 * What the agent may add is in its prompt, not here: a method next to the
 * two-step verification the account already has, never one that turns it on
 * or replaces another. The host cannot tell from a page.
 */

const inputSchema = z.object({
  method: z.enum(['passkey', 'authenticator_app', 'none']),
  click: z.string().max(16).optional(),
  username: z.string().trim().min(1).max(320),
  code_field: z.string().max(16).optional(),
  submit: z.string().max(16).optional(),
  qr: z.string().max(16).optional(),
  name: z.string().trim().min(1).max(64).optional(),
  reason: z.string().trim().min(1).max(500).optional(),
  user_request: z.string().trim().min(1).max(300).optional(),
}).loose()

const preparedSchema = z.object({ origin: z.string() })
const failureSchema = z.object({ error: z.string().optional(), problems: z.array(z.string()).optional() })
const setupSchema = z.object({ key: z.string().min(1).max(2048) })
const armedSchema = z.object({ armed: z.literal(true), clickError: z.string().optional() })
const createdSchema = z.object({ credential: passkeySchema.nullable() })

/** How long the agent's tab stays ready to create a passkey: the site may ask for its password, a code, a name first. */
const RECORD_MS = 10 * 60 * 1000
/** How long one call waits for the page to create it. */
const CREATE_WAIT_MS = 45_000

function refused(reason: string): HostToolResult {
  return { status: 'rejected', reason }
}

function resolved(resolution: Record<string, unknown>): HostToolResult {
  return { status: 'resolved', value: JSON.stringify(resolution) }
}

async function failureOf(response: Response, fallback: string): Promise<string> {
  const failure = failureSchema.safeParse(await response.json().catch(() => null))
  if (!failure.success) return fallback
  return failure.data.problems?.length ? failure.data.problems.join('; ') : failure.data.error ?? fallback
}

export async function addSignInMethod(request: HostToolRequest): Promise<HostToolResult> {
  const { agentSlug, sessionId, toolUseId } = request
  let raw: unknown = null
  try {
    raw = JSON.parse(request.input)
  } catch {
    // The model's input: refused below.
  }
  const parsed = inputSchema.safeParse(raw)
  if (!parsed.success) return refused('the call\'s input could not be read')
  const input = parsed.data
  // The container's tool checks these first; a call that got past it ends here.
  if (input.method === 'authenticator_app' && !input.code_field) return refused('map the field for the code that confirms the app (code_field: its ref)')
  if (input.method === 'none' && !input.reason) return refused('say why no method can be added (reason)')
  const container = agentRegistry.get(agentSlug).container
  const post = (path: string, body: Record<string, unknown>) => container.fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  // The page's site, never the agent's to name, and the field for the confirming code.
  const fields = input.method === 'authenticator_app'
    ? [{ ref: input.code_field, kind: 'otp', label: 'Code from the authenticator app', from: 'authenticator_app' }]
    : []
  const preparing = await post('/browser/login/prepare', {
    sessionId,
    toolUseId,
    fields,
    submitRef: input.method === 'authenticator_app' ? input.submit ?? null : null,
    providers: [],
  })
  if (!preparing.ok) return refused(`the page could not be used: ${await failureOf(preparing, `HTTP ${preparing.status}`)}`)
  const prepared = preparedSchema.safeParse(await preparing.json().catch(() => null))
  if (!prepared.success) return refused('the browser returned an unreadable page')
  const { origin } = prepared.data
  const site = siteOfOrigin(origin)
  if (!site || (await isOwnOrigin(origin, []))) return refused(`the page (${origin}) is not a site the vault keeps accounts for`)

  // An account the agent may use, and the user's word for it.
  const account = await findGrantedAccount(agentSlug, site, input.username)
  if (!account) return refused(`no saved account "${input.username}" on ${site} that you may use: sign in with request_login first (the user saves the account there)`)
  const asked = account.signInMethods.requested ? { request: true as const } : input.user_request ? { words: input.user_request } : null
  if (!asked) {
    return refused(`the user has not asked for a sign-in method on ${account.username}. Add one only when the user asked you (then pass their words in user_request)`)
  }

  if (input.method === 'passkey') return addPasskey({ request, account, origin, site, name: input.name ?? null, click: input.click ?? null, asked, post })
  if (input.method === 'none') {
    await markSignInMethodUnavailable({ agentSlug, accountId: account.id, reason: input.reason ?? '' })
    return resolved({ type: 'unavailable_noted', site, username: account.username })
  }

  // The setup on the page, read by the container: it comes only here.
  const reading = await post('/browser/login/authenticator', { toolUseId, ...(input.qr ? { qr: input.qr } : {}) })
  if (!reading.ok) return refused(await failureOf(reading, 'the setup could not be read from the page'))
  const read = setupSchema.safeParse(await reading.json().catch(() => null))
  const setup = read.success ? parseTotpSetup(read.data.key) : null
  if (!setup) return refused('the setup on the page is not one the vault can use: only an authenticator app\'s time-based codes (TOTP)')

  // Its current code confirms it on the page; the seed is saved only once that went in.
  const code = await freshTotpCode(setup.seed)
  const shown = noteUsername(account.username)
  const filled = await fillLoginInContainer(
    agentSlug,
    sessionId,
    toolUseId,
    { origin },
    [code],
    { ...(shown ? { username: shown } : {}), site, source: 'vault', saved: false, held: [] },
    { answer: false },
  )
  if (!filled.ok) return refused(filled.browserClosed ? 'the browser was closed' : filled.error)
  const report = filled.result.report
  if (!report) return refused('the browser did not say what the fill did')
  if (!fieldsWentIn(filled.result, 1)[0]) return resolved({ type: 'authenticator_not_added', site, username: account.username, report })
  try {
    await saveAuthenticator({ agentSlug, accountId: account.id, sessionId, setup, name: input.name ?? null, asked })
  } catch (error) {
    const why = error instanceof VaultConflictError ? error.message : 'the vault could not save it'
    return refused(`its code went into the page, but the app was not saved to the vault (${why}). If the page added it, remove it in the site's settings: nobody holds its codes`)
  }
  return resolved({ type: 'authenticator_added', site, username: account.username, issuer: setup.issuer, report })
}

/**
 * A passkey for the account: the tab records what the page creates (clicking
 * the site's button when the agent named one), and what it creates for this
 * site is sealed into the account. Nothing yet: the tab stays ready, and the
 * agent's next call takes it.
 */
async function addPasskey(input: {
  request: HostToolRequest
  account: VaultAccount
  origin: string
  site: string
  name: string | null
  click: string | null
  asked: { request: true } | { words: string }
  post: (path: string, body: Record<string, unknown>) => Promise<Response>
}): Promise<HostToolResult> {
  const { request, account, origin, site, post } = input
  const { agentSlug, sessionId } = request
  const arming = await post('/browser/passkey/arm', {
    sessionId,
    mode: 'record',
    ttlMs: RECORD_MS,
    // A second call goes on recording on the tab the first one armed.
    keep: true,
    ...(input.click ? { clickRef: input.click } : {}),
  })
  if (!arming.ok) return refused(await failureOf(arming, 'the browser could not get ready to create a passkey'))
  const armed = armedSchema.safeParse(await arming.json().catch(() => null))
  if (!armed.success) return refused('the browser returned an unreadable answer')
  const clickError = armed.data.clickError
  const taking = await post('/browser/passkey/created', { waitMs: clickError ? 0 : CREATE_WAIT_MS })
  const created = createdSchema.safeParse(await taking.json().catch(() => null))
  const passkey = taking.ok && created.success ? created.data.credential : null
  if (!passkey) return resolved({ type: 'passkey_pending', site, username: account.username, ...(clickError ? { clickError } : {}) })
  // Only one for this site goes to the account: the tab may have moved on to another.
  if (!passkeyWorksOn(passkey.rpId, hostnameOf(origin))) {
    return refused(`the page created a passkey for ${passkey.rpId}, not for ${site}, so it was not saved to ${account.username}`)
  }
  try {
    await savePasskey({ agentSlug, accountId: account.id, sessionId, passkey, name: input.name, asked: input.asked })
  } catch (error) {
    const why = error instanceof VaultConflictError ? error.message : 'the vault could not save it'
    return refused(`the page created a passkey, but it was not saved to the vault (${why}). Remove it in the site's settings: nobody holds it`)
  }
  return resolved({ type: 'passkey_added', site, username: account.username, rpId: passkey.rpId })
}
