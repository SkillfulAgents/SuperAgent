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
import { redactToolResult } from '../injected-secrets'
import { loginResolutionSchema, MAX_LOGIN_FIELDS, type LoginFillReport, type LoginResolution } from '../login-schema'

const CONTAINER_URL = `http://localhost:${process.env.PORT || '3000'}`

const DESCRIPTION = `Ask the user to sign in through a secure form. Map the page's sign-in fields by ref; the user types their credentials into a form in the app, and the host writes them straight into the page and submits it. Passwords and codes never pass through you.

Use this when the page asks for credentials: a username or email, a password, a one-time code (from SMS, email or an authenticator app), or several of these together. Map the fields shown on the page now. When a sign-in is split over steps (email first, then password), map this step's fields, and call again on the next step.

Hand the browser over with request_browser_input instead for what only the user can do on the page: a CAPTCHA, a passkey or security key, approving the sign-in on their phone, choosing an account in a "Sign in with Google" window, or a consent screen.

The result says which fields were filled on which site, whether the form was submitted, and what the page did next (like a click result). It never contains the values. When the site rejects the credentials, the page says so; call request_login again to let the user correct them.`

const fieldSchema = z.object({
  ref: z.string().describe('The field\'s ref from your latest snapshot (e.g. "@e12")'),
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
      fields: z.array(fieldSchema).min(1).max(MAX_LOGIN_FIELDS).describe('The sign-in fields on the page now, in the order a person fills them'),
      submit: z.string().optional().describe('Ref of the button that submits the form. Omit it to press Enter in the last field instead.'),
    },
    // Every answer is redacted: problems can quote the CLI, and the page's URL
    // after the submit can carry a value (a GET form).
    async (args) => redactToolResult(await requestLogin(args, getSessionId)),
  )
}

async function requestLogin(
  args: { message: string; fields: Array<{ ref: string; kind: (typeof LOGIN_FIELD_KINDS)[number]; label: string }>; submit?: string },
  getSessionId: () => string | null,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
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

  console.log(`[request_login] Locating ${args.fields.length} sign-in field(s) for ${toolUseId}`)
  let prepared: { origin: string; fields: Array<{ ref: string; kind: string; label: string }> }
  try {
    const response = await fetch(`${CONTAINER_URL}/browser/login/prepare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...hostAuthHeaders() },
      body: JSON.stringify({ sessionId, toolUseId, fields: args.fields, submitRef: args.submit ?? null }),
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
    const value = await inputManager.createPendingWithType<string>(toolUseId, 'login', {
      message: args.message,
      origin: prepared.origin,
      fields: prepared.fields.map(({ ref, kind, label }) => ({ ref, kind, label })),
    })
    const parsed = loginResolutionSchema.safeParse(parseJson(value))
    if (!parsed.success) return errorResult('The sign-in request ended with an unreadable result.')
    return formatLoginResolution(parsed.data)
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

/** The tool result for how the request ended: observations, never values. */
export function formatLoginResolution(resolution: LoginResolution): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } {
  if (resolution.type === 'manual') {
    return { content: [{ type: 'text', text: 'The user signed in on the page themselves and is done. Take a browser snapshot to see the current state.' }] }
  }

  const { origin, outcomes, lost, submitted, submitError, observation, changedSecrets, pageActivity } = resolution
  const filled = outcomes.filter((outcome) => outcome.status === 'filled' || outcome.status === 'changed')
  const name = (outcome: (typeof outcomes)[number]) => `${outcome.ref} "${outcome.label}" (${outcome.kind})`
  const lines: string[] = [
    filled.length
      ? `Filled ${filled.length} of ${outcomes.length} field${outcomes.length === 1 ? '' : 's'} on ${origin} with the user's input: ${filled.map(name).join(', ')}.`
      : `No field was filled on ${origin}.`,
  ]
  for (const outcome of outcomes) {
    if (outcome.status === 'changed') lines.push(`${outcome.ref} read back different from what the user entered (the page changed it as it was written).`)
    if (outcome.boxes) lines.push(`${outcome.ref}: the code went into ${outcome.boxes} one-character boxes.`)
    if (outcome.status === 'skipped') lines.push(`${name(outcome)} was left empty by the user.`)
    if (outcome.status === 'failed') lines.push(`${name(outcome)} was not filled: ${outcome.problem ?? 'the write failed'}.`)
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
