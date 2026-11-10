import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { getBrowserState } from '../browser-state'
import { inputManager } from '../input-manager'
import { keptSpans, redactToolResult } from '../injected-secrets'
import { forgetPreparedLogin } from '../login-requests'
import { elementRefSchema, signInMethodResolutionSchema, type SignInMethodResolution } from '../login-schema'
import { formatLoginResolution } from './request-login'

const DESCRIPTION = `Add a sign-in method to a saved account, so later sign-ins need nobody: the vault keeps it and request_login uses it. Only when the user asked you for one, in their own message (also one sent from the sign-in form or Settings → Logins); pass their words in user_request.

Add a passkey when the site offers passkeys (sites keep several, and one changes nothing else about the account); else an authenticator app.

Never weaken or change the user's own sign-in. Add a method only next to the two-step verification the account already has: never turn two-step verification on where it is off, and never replace or remove a method the account has. When the site offers nothing that fits (two-step verification is off, or the page says adding an app replaces the current one), call this tool with method "none" and the reason instead: the user is told, and agents stop being asked. Not for a page that fails to load or shows an error: tell the user that instead, and the request stays for a later try.

method "passkey": sign in (request_login), open the site's security settings and find where it adds a passkey. Call this tool with the account's username and the ref of the button that starts it (click): the browser gets ready to create the passkey, clicks it, and saves the passkey the site creates to the vault. Name it "Gamut" if the page asks for a name (pass it as name). If the site asks for its password or a code first, sign in with request_login, then call this tool again (without click) once the page says the passkey was added: the browser stays ready for ten minutes.

method "authenticator_app": sign in (request_login), open the site's security settings and start adding an authenticator app (a "TOTP" or "2FA" app). When the page shows the setup QR code and asks for the code from the app, call this tool with the account's username and the ref of the field for that code in code_field (and the button that confirms it in submit). When the page also asks for a name for the app (a device name), type "Gamut" there first and pass it as name: at sign-in, a site that lists the apps by name shows that one. Do not open "Can't scan it?" or copy the key: the tool reads the setup from the page itself, saves it to the account, and fills the app's current code to confirm it. When the page shows more than one QR code, pass the setup QR code's ref as qr. If the site asks for the password or a code first, sign in with request_login as usual.

The result says what was saved and what the page did after the code went in. It never contains the key or the code.`

const inputSchema = {
  method: z.enum(['passkey', 'authenticator_app', 'none']).describe('passkey: add a passkey (preferred where the site offers them). authenticator_app: add an authenticator app now. none: the site offers no method you may add (say why in reason); not for a page that failed.'),
  click: elementRefSchema.optional().describe('passkey: ref of the site\'s button that starts adding a passkey ("Add a passkey", "Create passkey").'),
  username: z.string().trim().min(1).max(320).describe('The saved account, exactly as a request_login result named it.'),
  code_field: elementRefSchema.optional().describe('authenticator_app: ref of the field for the code that confirms the app, from your latest snapshot.'),
  submit: elementRefSchema.optional().describe('authenticator_app: ref of the button that confirms the app. Omit it to press Enter in the code field.'),
  qr: elementRefSchema.optional().describe('authenticator_app: ref of the setup QR code, when the page shows more than one QR code.'),
  name: z.string().trim().min(1).max(64).optional().describe('The name you typed for the passkey or app on the page, when it asked for one ("Gamut").'),
  reason: z.string().trim().min(1).max(500).optional().describe('none: why no method can be added, as the page shows it (e.g. "Two-factor authentication is off for this account").'),
  user_request: z.string().trim().min(1).max(300).optional().describe('The user\'s words asking for it.'),
}

/** How long the host may take: locating the field, reading the setup, a code's wait for its period, the fill and the page's answer. */
const HOST_TIMEOUT_MS = 3 * 60 * 1000

export function createAddSignInMethodTool() {
  return tool(
    'add_sign_in_method',
    DESCRIPTION,
    inputSchema,
    async (args) => {
      const kept = keptSpans()
      return redactToolResult(await addSignInMethod(args, kept.wrap), kept)
    },
  )
}

type Args = z.infer<z.ZodObject<typeof inputSchema>>
type Result = { content: Array<{ type: 'text'; text: string }>; isError?: boolean }

async function addSignInMethod(args: Args, name: (username: string) => string): Promise<Result> {
  const toolUseId = inputManager.consumeCurrentToolUseId()
  if (!toolUseId) return errorResult('Unable to add a sign-in method - no tool use ID available.')
  if (args.method === 'authenticator_app' && !args.code_field) return errorResult('Nothing was added: map the field for the code that confirms the app (code_field: its ref).')
  if (args.method === 'none' && !args.reason) return errorResult('Nothing was noted: say why no method can be added (reason).')
  // The site is the page's, never the agent's to say: the browser must be open on it.
  if (!getBrowserState().active) return errorResult('Nothing was added: no browser is open. Open the site\'s page with browser_open first.')
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    // Answered by the host, which locates the field, reads the setup from the page and fills the code.
    const value = await Promise.race([
      inputManager.createPendingWithType<string>(toolUseId, 'add_sign_in_method'),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('the host did not answer in time')), HOST_TIMEOUT_MS)
      }),
    ])
    const parsed = signInMethodResolutionSchema.safeParse(parseJson(value))
    if (!parsed.success) return errorResult('The request ended with an unreadable result.')
    return formatSignInMethodResolution(parsed.data, name)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return errorResult(`Nothing was added: ${sentence(message)}`)
  } finally {
    if (timer) clearTimeout(timer)
    forgetPreparedLogin(toolUseId)
  }
}

/** The tool result: observations, never the key or the code. */
export function formatSignInMethodResolution(resolution: SignInMethodResolution, named: (username: string) => string = (username) => username): Result {
  const account = named(resolution.username)
  if (resolution.type === 'passkey_added') {
    return {
      content: [{
        type: 'text',
        text: `Saved the passkey the page created for ${account} on ${resolution.site} (for ${resolution.rpId}) to the vault. Check that the page lists it. From now on, signing in with request_login holds it in the browser: use the page's passkey option then.`,
      }],
    }
  }
  if (resolution.type === 'passkey_pending') {
    const click = resolution.clickError ? ` Clicking the button failed (${resolution.clickError}).` : ''
    return {
      content: [{
        type: 'text',
        text: `No passkey was created yet.${click} The browser stays ready to create one for ten minutes: go through what the page asks (sign in with request_login if it asks for the password or a code), and once it says the passkey was added, call add_sign_in_method again with method "passkey" and no click to save it.`,
      }],
      isError: true,
    }
  }
  if (resolution.type === 'unavailable_noted') {
    return { content: [{ type: 'text', text: `Noted: no sign-in method can be added to ${account} on ${resolution.site}. The user sees why in Settings → Logins, and agents are no longer asked to add one.` }] }
  }
  const fill = formatLoginResolution(resolution.report, named)
  const page = fill.content.map((part) => part.text).join('\n')
  if (resolution.type === 'authenticator_not_added') {
    return {
      content: [{ type: 'text', text: `Read the authenticator app's setup on ${resolution.site}, but its code did not go into the page, so nothing was saved.\n${page}` }],
      isError: true,
    }
  }
  const issuer = resolution.issuer ? ` (set up as "${resolution.issuer}")` : ''
  return {
    content: [{
      type: 'text',
      text: [
        `Saved an authenticator app for ${account} on ${resolution.site} to the vault${issuer}, and filled its current code to confirm it.`,
        'Check that the page confirms the app was added. If it says the code is wrong, call this tool again: it fills a new code.',
        `From now on, when a sign-in asks for the code from an authenticator app, map that field in request_login with from: "authenticator_app" and the vault fills it.`,
        page,
      ].join('\n'),
    }],
  }
}

function errorResult(text: string): Result {
  return { content: [{ type: 'text', text }], isError: true }
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
