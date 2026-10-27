import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { inputManager } from '../input-manager'
import { getBrowserState } from '../browser-state'
import { hostAuthHeaders } from '../host-auth'
import { tabManager } from '../tab-manager'
import { formatUrlDigest, type UrlDigest } from '../browser-digest'
import { formatActionEffect, type ActionEffect, type EffectTreeDiff } from '../action-settle'
import { LOGIN_FIELD_KINDS } from '../login-form-script'
import { withoutQuery } from '../login-fill'
import { forgetPreparedLogin } from '../login-requests'
import { keptSpans, redactToolResult } from '../injected-secrets'
import {
  loginResolutionSchema,
  MAX_LOGIN_FIELDS,
  SIGN_IN_PROVIDER_IDS,
  type LoginFillAccount,
  type LoginFillReport,
  type LoginResolution,
  type SignInProviderId,
  type VaultAccountView,
} from '../login-schema'

const CONTAINER_URL = `http://localhost:${process.env.PORT || '3000'}`

const DESCRIPTION = `Sign the browser in to the site on the page. Map the page's sign-in fields by ref; the host fills them from the user's saved accounts, or from a form the user fills in the app, and submits. Passwords and codes never pass through you.

Use this when the page asks for credentials: a username or email, a password, a one-time code (from SMS, email or an authenticator app), or several of these together. Each call is one step of a sign-in:
1. Call it without username first. When the user has saved accounts on this site that you may use, the result lists them and nothing is filled. Otherwise the user gets the form.
2. To sign in with a listed account, call again with username set to it. The host fills the mapped fields from it and submits. When the account lacks a value the page asks for (a code, a new field), the user is asked for just that. When the account has a session saved from an earlier sign-in, the host may restore that instead and load the page again: check whether it shows you signed in, and if it asks you to sign in, call again with the same username. To switch a site to another of your accounts there, call with its username (no fields needed): its saved session replaces the current one when it has one.
3. A sign-in split over steps (email first, then password) takes one call per step. Pass the username you used on the earlier step. When a page asks for the email or username alone, also map the password without a ref: the user enters both at once, and the host fills the password when a later call maps that field.
4. When the site rejects the sign-in (a wrong or changed password), call again with that username, ask_user: true, and reason set to what the page said. The user enters it again; until they do, the vault fills that account's password only with them. For another account, call with ask_user: true and no username.

Sign-in through another account ("Continue with Google", GitHub, Microsoft): which account to use is the user's to say. On a page with such buttons, list them in providers on every call: the user's form offers exactly those. Before you click one, call request_login on the site (without fields when the page shows none). The result names the account the user signs in with ("signs in with the Google account x@gmail.com"), or the user picks it in the form. Then click the button yourself and pick exactly that account in the provider's account chooser, never another; if the provider asks to sign in, call request_login there with that username.

When the sign-in asks to verify it's you, the way is the user's to choose whenever the page offers more than one: a list of ways (a code by text or email, a prompt on the phone, a passkey), or one way (a passkey or phone prompt) with "Try another way". Open that list and have the user pick one before you click it; never hand the browser over on such a page before they picked. A code then goes in with this tool; after a prompt to their phone, wait for the page to move on by itself (up to about two minutes).

Hand the browser over with request_browser_input instead for what only the user can do on the page: a CAPTCHA, a consent screen, a passkey or security key the user picked or the page's only way, or a phone prompt still pending after that wait.

The result says which account was used, which fields were filled on which site, whether the form was submitted, and what the page did next (like a click result). It never contains the values. When the site rejects the credentials, the page says so.`

const fieldSchema = z.object({
  ref: z.string().optional().describe('The field\'s ref from your latest snapshot (e.g. "@e12"). Omit it only for a password or text field of a later step, asked now (see step 3).'),
  kind: z.enum(LOGIN_FIELD_KINDS).describe(
    'username: the account identifier (username, email or phone number). password: the account password (a password input only). otp: a one-time code; for a code split across one-character boxes, map the first box. text: another field the step asks for that is not secret, such as a company or workspace name.'
  ),
  label: z.string().describe('The field\'s label as the page shows it (e.g. "Email address")'),
})

export function createRequestLoginTool(getSessionId: () => string | null) {
  return tool(
    'request_login',
    DESCRIPTION,
    {
      message: z.string().trim().min(1).describe(
        "Why the agent needs the user signed in, as one sentence ending with a period. Never use first person. Example: 'Sign in to GitHub so the agent can update the repository settings.'"
      ),
      fields: z.array(fieldSchema).max(MAX_LOGIN_FIELDS).optional().describe('The sign-in fields on the page now, in the order a person fills them. Omit them on a page that offers only buttons like "Continue with Google".'),
      submit: z.string().optional().describe('Ref of the button that submits the form. Omit it to press Enter in the last field instead.'),
      username: z.string().trim().min(1).max(320).optional().describe('Sign in with this saved account: its username exactly as an earlier request_login result gave it. Omit it to see the saved accounts you may use on this site.'),
      ask_user: z.boolean().optional().describe('Show the user the form even when saved accounts exist: for another account, or after the site rejected a saved one (with username, the form is for that account and what the user enters updates it).'),
      reason: z.string().trim().min(1).max(500).optional().describe('With ask_user: why you ask the user, quoting what the page said when it rejected the sign-in (e.g. \'The page says "Incorrect password."\'). Shown to the user.'),
      providers: z.array(z.enum(SIGN_IN_PROVIDER_IDS)).max(SIGN_IN_PROVIDER_IDS.length).optional().describe('The services the page shows buttons for signing in with ("Sign in with Google", "Continue with Apple"), in the page\'s order. Omit services the page does not show, and passkeys.'),
    },
    // Every answer is redacted: problems can quote the CLI, and the page's URL
    // after the submit can carry a value (a GET form). Only the usernames the
    // host names stay whole, where the result names them: the agent passes
    // them back exactly.
    async (args) => {
      const kept = keptSpans()
      return redactToolResult(await requestLogin(args, getSessionId, kept.wrap), kept)
    },
  )
}

interface RequestLoginArgs {
  message: string
  fields?: Array<{ ref?: string; kind: (typeof LOGIN_FIELD_KINDS)[number]; label: string }>
  submit?: string
  username?: string
  ask_user?: boolean
  reason?: string
  providers?: SignInProviderId[]
}

async function requestLogin(
  args: RequestLoginArgs,
  getSessionId: () => string | null,
  name: (username: string) => string,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  const fields = args.fields ?? []
  const toolUseId = inputManager.consumeCurrentToolUseId()
  if (!toolUseId) {
    console.error('[request_login] No toolUseId available')
    return errorResult('Unable to process the sign-in request - no tool use ID available.')
  }
  if (!getBrowserState().active) {
    return errorResult('Sign-in request cancelled: no browser is open (it may have just been closed). Open the page with browser_open first.')
  }
  const sessionId = getSessionId()
  if (!sessionId) return errorResult('Unable to process the sign-in request - no session ID available.')

  console.log(`[request_login] Locating ${fields.length} sign-in field(s) for ${toolUseId}`)
  let prepared: { origin: string; fields: Array<{ ref: string; kind: string; label: string }> }
  try {
    const response = await fetch(`${CONTAINER_URL}/browser/login/prepare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...hostAuthHeaders() },
      body: JSON.stringify({ sessionId, toolUseId, fields, submitRef: args.submit ?? null, providers: args.providers ?? [] }),
    })
    const data = await response.json() as { error?: string; problems?: string[]; origin?: string; fields?: typeof prepared.fields }
    if (!response.ok || !data.origin || !data.fields) {
      // The host may still be reading the failure to drop its card.
      setTimeout(() => forgetPreparedLogin(toolUseId), 60_000).unref()
      const problems = data.problems?.length ? data.problems : [data.error || `HTTP ${response.status}`]
      return errorResult(`The sign-in form was not shown to the user. ${problems.map(sentence).join(' ')}`)
    }
    prepared = { origin: data.origin, fields: data.fields }
  } catch (error) {
    forgetPreparedLogin(toolUseId)
    return errorResult(`The sign-in form was not shown to the user: ${error instanceof Error ? error.message : 'the browser could not be reached'}.`)
  }

  // As request_browser_input: the browser may have closed while the
  // fields were located, and a close only rejects requests that exist.
  // This check and the registration below run in one synchronous block.
  if (!getBrowserState().active) {
    forgetPreparedLogin(toolUseId)
    return errorResult('Sign-in request cancelled: the browser was closed.')
  }
  try {
    // Answered by the host: from a saved account, with the list of them, or
    // with what the user entered in the form.
    const value = await inputManager.createPendingWithType<string>(toolUseId, 'login', {
      message: args.message,
      origin: prepared.origin,
      fields: prepared.fields.map(({ ref, kind, label }) => ({ ref, kind, label })),
      ...(args.username ? { username: args.username } : {}),
    })
    const parsed = loginResolutionSchema.safeParse(parseJson(value))
    if (!parsed.success) return errorResult('The sign-in request ended with an unreadable result.')
    return formatLoginResolution(parsed.data, name)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.log(`[request_login] Request ended without a fill: ${message}`)
    // Only a decline is the user's word on the matter; a closed browser or a
    // timeout says nothing about what they want.
    const declined = /declin/i.test(message)
    return errorResult(`Sign-in request cancelled: ${sentence(message)}${declined ? ' The user may want to discuss the task with you.' : ''}`)
  } finally {
    forgetPreparedLogin(toolUseId)
  }
}

function errorResult(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true }
}

function sentence(text: string): string {
  const trimmed = text.trim()
  const capitalized = trimmed.charAt(0).toUpperCase() + trimmed.slice(1)
  return /[.!?]$/.test(capitalized) ? capitalized : `${capitalized}.`
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

/** What the page did by itself after the fill, as seen. */
function describePageActivity(activity: NonNullable<LoginFillReport['pageActivity']>): string {
  switch (activity.kind) {
    case 'navigation': return `After the values went in, the page started loading ${activity.url ? withoutQuery(activity.url) : 'a new document'}`
    case 'request': return `After the code went in, the page sent it in a ${activity.method} to ${withoutQuery(activity.url)}`
    case 'detached': return `After the values went in, ${activity.ref} was no longer in its document`
    case 'locked': return `After the values went in, ${activity.ref} became disabled or read-only`
    case 'gone': return 'After the values went in, the document that held the fields was gone'
    case 'unreadable': return `After the values went in, the page could not be read (${activity.error})`
  }
}

/** A username as the result names it: kept whole by the redaction (see keptSpans). */
type Name = (username: string) => string
const plain: Name = (username) => username

/** What a saved account holds, as the agent may know it: part names, never values. */
function describeAccount(account: VaultAccountView, named: Name): string {
  const name = `${named(account.username)}${account.label ? ` ("${account.label}")` : ''}`
  if (account.via) return `${name}: signs in with the ${account.via.name} account ${named(account.via.username)} (${account.via.site})`
  const parts = account.parts.map((part) => (part === 'password' ? 'a password' : `"${part.replace(/^text:/, '')}"`))
  if (parts.length === 0) return `${name}: no saved password or other value yet`
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0]
  const rejected = account.rejected ? ' (the site rejected its saved password, as reported earlier: using it asks the user)' : ''
  return `${name}: holds ${list}${rejected}`
}

function formatAccounts(resolution: Extract<LoginResolution, { type: 'accounts' }>, named: Name): string {
  if (resolution.named) {
    return [
      'Nothing was filled: this call mapped no field.',
      `- ${describeAccount(resolution.accounts[0], named)}`,
      'To sign in with it, call request_login with username set to it and the page\'s sign-in fields mapped by ref.',
    ].join('\n')
  }
  return [
    `Nothing was filled. Saved accounts on ${resolution.site} you may use:`,
    ...resolution.accounts.map((account) => `- ${describeAccount(account, named)}`),
    'To sign in with one, call request_login again with username set to it. To ask the user for another account, call it with ask_user: true.',
  ].join('\n')
}

function formatVia(resolution: Extract<LoginResolution, { type: 'via' }>, named: Name): string {
  const { provider } = resolution
  const account = named(provider.username)
  return [
    `Nothing was filled. The user signs in to ${resolution.site} with the ${provider.name} account ${account}${resolution.saved ? ', saved to their vault for this site' : ''}.`,
    `Click the site's ${provider.name} sign-in button yourself. If ${provider.name} shows an account chooser, pick ${account} and no other account; if it asks to sign in, call request_login on its page with username "${account}". Back on ${resolution.site}, check which account the page shows.`,
  ].join('\n')
}

function formatBrowserClosed(resolution: Extract<LoginResolution, { type: 'browser_closed' }>, named: Name): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } {
  const { site, kept } = resolution
  const closed = 'The browser was closed before anything went into the page.'
  if (!kept) {
    return {
      content: [{ type: 'text', text: `${closed} Nothing the user entered is kept. To sign in to ${site}, open its sign-in page again and call request_login: the user is asked again.` }],
      isError: true,
    }
  }
  const account = kept.username ? named(kept.username) : null
  const which = account ? ` ${account}` : ''
  const what = {
    saved: `The user saved the account${which} on ${site} to their vault, for you to use.`,
    picked: `The user picked their saved account${which} on ${site}, for you to use.`,
    vault: null,
    held: `The host holds what the user entered${account ? ` for the account ${account}` : ''} on ${site} for 30 minutes.`,
  }[kept.how]
  const call = `call request_login${account ? ` with username "${account}"` : ''}`
  const next = kept.how === 'held'
    ? `Open its sign-in page again within that time and ${call}: the host fills it in without asking the user again.`
    : `Open its sign-in page again and ${call}: the host signs in with it.`
  return { content: [{ type: 'text', text: [what ? `${closed} ${what}` : closed, next].join('\n') }] }
}

function formatSession(resolution: Extract<LoginResolution, { type: 'session' }>, named: Name): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } {
  const account = named(resolution.username)
  const again = `call request_login again with username "${account}" and the page's sign-in fields mapped by ref: the vault fills the account's saved values then.`
  const digest = (resolution.observation?.digest as UrlDigest | undefined) ?? null
  if (resolution.restored) {
    return {
      content: [{
        type: 'text',
        text: [
          `Nothing was filled: the vault restored the saved session of ${account} on ${resolution.site} (the cookies and storage of an earlier sign-in), and the page loaded again: refs from earlier snapshots are stale.`,
          `If the page asks you to sign in, ${again}`,
        ].join('\n') + formatUrlDigest(digest),
      }],
    }
  }
  const state = resolution.cleared
    ? `so the browser was signed out of ${resolution.site} and the page loaded again`
    : `and the browser may hold part of it on ${resolution.site}`
  return {
    content: [{ type: 'text', text: `Nothing was filled: the saved session of ${account} could not be restored, ${state}.\nTo sign in, ${again}${formatUrlDigest(digest)}` }],
    isError: true,
  }
}

/** Where the values came from and what was kept for later, by account. */
function accountLines(account: LoginFillAccount | undefined, named: Name): string[] {
  if (!account) return []
  const lines: string[] = []
  if (account.source === 'user' && account.saved && account.username) lines.push(`The user saved this to their vault as account ${named(account.username)} on ${account.site}.`)
  if (account.held.length) {
    const labels = account.held.map((label) => `"${label}"`).join(', ')
    lines.push(account.username
      ? `The user also entered ${labels} for a later step; the host holds it for account ${named(account.username)}. When the page asks for it, call request_login with username "${named(account.username)}" and map that field.`
      : `The user also entered ${labels} for a later step; the host holds it. When the page asks for it, call request_login and map that field.`)
  }
  return lines
}

/**
 * The tool result for how the request ended: observations, never values.
 * `named` wraps each username the host names (see keptSpans).
 */
export function formatLoginResolution(resolution: LoginResolution, named: Name = plain): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } {
  if (resolution.type === 'manual') {
    return { content: [{ type: 'text', text: 'The user signed in on the page themselves and is done. Take a browser snapshot to see the current state.' }] }
  }
  if (resolution.type === 'accounts') return { content: [{ type: 'text', text: formatAccounts(resolution, named) }] }
  if (resolution.type === 'via') return { content: [{ type: 'text', text: formatVia(resolution, named) }] }
  if (resolution.type === 'browser_closed') return formatBrowserClosed(resolution, named)
  if (resolution.type === 'session') return formatSession(resolution, named)

  const { origin, outcomes, lost, submitted, submitError, observation, changedSecrets, pageActivity, account } = resolution
  const filled = outcomes.filter((outcome) => outcome.status === 'filled' || outcome.status === 'changed')
  const unconfirmed = outcomes.some((outcome) => outcome.status === 'unconfirmed')
  const name = (outcome: (typeof outcomes)[number]) => `${outcome.ref} "${outcome.label}" (${outcome.kind})`
  // The account by name either way: a later step names it to fill as that account.
  const whose = account?.username ? ` ${named(account.username)}` : ''
  const from = account?.source === 'vault' ? `from the saved account${whose}` : `with the user's input${whose ? ` for the account${whose}` : ''}`
  const lines: string[] = [
    filled.length
      ? `Filled ${filled.length} of ${outcomes.length} field${outcomes.length === 1 ? '' : 's'} on ${origin} ${from}: ${filled.map(name).join(', ')}.`
      : unconfirmed ? `No write on ${origin} was confirmed.` : `No field was filled on ${origin}.`,
    ...accountLines(account, named),
  ]
  for (const outcome of outcomes) {
    if (outcome.status === 'changed') lines.push(`${outcome.ref} read back different from what the user entered (the page changed it as it was written).`)
    if (outcome.boxes) lines.push(`${outcome.ref}: the code went into ${outcome.boxes} one-character boxes.`)
    if (outcome.status === 'skipped') lines.push(`${name(outcome)} was left empty by the user.`)
    if (outcome.status === 'failed') lines.push(`${name(outcome)} was not filled: ${outcome.problem ?? 'the write failed'}.`)
    if (outcome.status === 'unconfirmed') lines.push(`${name(outcome)}: ${outcome.problem ?? 'the write was sent and returned no answer'}.`)
  }
  for (const lostField of lost) {
    if (lostField.state === 'detached') lines.push(`Just before the submit, ${lostField.ref} was no longer in its document.`)
    else if (lostField.state === 'differs') lines.push(`Just before the submit, ${lostField.ref} held a different value than was written.`)
    else lines.push(`Just before the submit, ${lostField.ref} could not be read back (${lostField.error ?? 'no answer'}).`)
  }

  const lastField = filled[filled.length - 1]?.ref ?? 'the last field'
  const plain = (text: string) => text.replace(/\.+$/, '')
  const nothing = 'nothing was clicked or pressed.'
  if (submitted?.via === 'click') lines.push(`Clicked ${submitted.ref}.`)
  else if (submitted?.via === 'click-in-page') lines.push(`The CLI did not click ${submitted.ref} (${plain(submitted.clickError)}); it was clicked from inside the page instead.`)
  else if (submitted?.via === 'enter') lines.push(`Pressed Enter in ${lastField}.`)
  else if (submitted?.via === 'page') lines.push(`A submit event fired in the page as the values went in; ${nothing}`)
  else if (pageActivity) lines.push(`${describePageActivity(pageActivity)}; ${nothing}`)
  else if (changedSecrets?.length) lines.push(`Just before the submit, ${changedSecrets.join(', ')} still held a different value than the user entered; ${nothing}`)
  else if (submitError) lines.push(sentence(submitError))
  else lines.push(`Nothing was clicked or pressed.`)

  let text = lines.join('\n')
  if (observation) {
    const tabInfo = observation.tabInfo as { activeId: string; activeUrl: string; tabCount: number } | undefined
    const digest = (observation.digest as UrlDigest | undefined) ?? null
    const effect = (observation.effect as ActionEffect | undefined) ?? null
    const treeDiff = (observation.treeDiff as EffectTreeDiff | undefined) ?? null
    const settleMs = typeof observation.settleMs === 'number' ? observation.settleMs : 300
    if (tabInfo) {
      text += tabManager.formatTabNotification(tabInfo)
    } else {
      text += formatUrlDigest(digest)
      text += formatActionEffect(effect, { settleMs, verb: submitted?.via === 'enter' ? 'press' : 'click', treeDiff })
    }
  }
  return {
    content: [{ type: 'text', text }],
    ...(filled.length === 0 ? { isError: true } : {}),
  }
}
