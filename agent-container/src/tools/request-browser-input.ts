import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { inputManager } from '../input-manager'
import { getBrowserState } from '../browser-state'
import { hostAuthHeaders } from '../host-auth'

const CONTAINER_URL = `http://localhost:${process.env.PORT || '3000'}`

/** A question answered this recently means the user was just asked: the hand-over goes ahead. */
const QUESTION_FRESH_MS = 10 * 60 * 1000
const PAGE_READ_TIMEOUT_MS = 3_000

/** The name of a control that lists other ways to verify a sign-in ("Try another way"). */
export const ANOTHER_WAY_PATTERN = /\btry another way\b|\b(?:sign|log) ?in (?:another|a different) way\b|\b(?:other|more) ways to (?:sign ?in|log ?in|verify)\b|\b(?:use|choose|try) (?:another|a different) (?:verification |sign-in )?(?:method|option)\b|\bverify with something else\b/i

/** In the page: the first visible control so named, and the page (origin and path) it is on. */
const ANOTHER_WAY_SCRIPT = `(() => {
  const pattern = new RegExp(${JSON.stringify(ANOTHER_WAY_PATTERN.source)}, 'i');
  for (const el of document.querySelectorAll('button, a, [role="button"], [role="link"], input[type="submit"], input[type="button"]')) {
    const name = (el.getAttribute('aria-label') || el.innerText || el.value || '').replace(/\\s+/g, ' ').trim();
    const box = el.getBoundingClientRect();
    if (name && name.length <= 80 && pattern.test(name) && box.width > 0 && box.height > 0 && getComputedStyle(el).visibility !== 'hidden') {
      return JSON.stringify({ name, page: location.origin + location.pathname });
    }
  }
  return '';
})()`

const anotherWaySchema = z.object({ name: z.string().min(1).max(200), page: z.string().min(1).max(2048) })

/** The script's result from the eval route's output, which the CLI may JSON-quote once more. */
export function parseAnotherWay(output: unknown): z.infer<typeof anotherWaySchema> | null {
  if (typeof output !== 'string' || !output.trim()) return null
  try {
    let parsed: unknown = JSON.parse(output.trim())
    if (typeof parsed === 'string') parsed = parsed ? JSON.parse(parsed) : null
    const result = anotherWaySchema.safeParse(parsed)
    return result.success ? result.data : null
  } catch {
    return null
  }
}

/** Whether the open page offers other ways to verify a sign-in. Any failure reads as no. */
async function anotherWayOnPage(): Promise<z.infer<typeof anotherWaySchema> | null> {
  const { active, sessionId } = getBrowserState()
  if (!active || !sessionId) return null
  try {
    const response = await fetch(`${CONTAINER_URL}/browser/eval`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...hostAuthHeaders() },
      body: JSON.stringify({ sessionId, script: ANOTHER_WAY_SCRIPT }),
      signal: AbortSignal.timeout(PAGE_READ_TIMEOUT_MS),
    })
    if (!response.ok) return null
    const data = await response.json() as { output?: unknown }
    return parseAnotherWay(data.output)
  } catch {
    return null
  }
}

/** Verification pages refused once, per session (session, origin and path): a second call there is handed over. */
const refusedPages = new Set<string>()
const REFUSED_PAGES_CAP = 200

export const requestBrowserInputTool = tool(
  'request_browser_input',
  `Hand the browser to the user for a step only a human can perform on the page: a CAPTCHA, a consent screen, a passkey or security key, or a prompt on their phone that the page still waits on after a couple of minutes. When you hit one of these, call this tool instead of just describing the obstacle in chat. A sign-in form (username, password, one-time code) goes through request_login instead.

Never call it on a sign-in's verification page that shows "Try another way" (or another list of ways) before the user picked the way: open that list and have the user choose first.

Do NOT use this tool when you only need information or a decision from the user (a phone number, address, which option to pick — such as which way to verify a sign-in — whether to submit). Ask with AskUserQuestion instead, then fill the page yourself — the answer is easier to give and stays in the conversation for next time.

The user will see your message and requirements in the UI alongside the browser preview. The tool blocks until the user clicks "Complete" or chooses to chat with you instead. After the user completes, take a browser snapshot to see the current state.

Example:
- message: "Solve the CAPTCHA to continue the data export."
- requirements: ["Solve the CAPTCHA on the open page", "Wait until the export page appears"]`,
  {
    message: z.string().describe(
      "A short statement describing what the user needs to do. Never use first person or greetings. Must end with a period. Example: 'Solve the CAPTCHA to continue the data export.'"
    ),
    requirements: z.array(z.string()).default([]).describe(
      'Optional formal list of specific actions the user should complete'
    ),
  },
  async (args) => {
    console.log(`[request_browser_input] Requesting browser input: ${args.message}`)

    const toolUseId = inputManager.consumeCurrentToolUseId()

    if (!toolUseId) {
      console.error('[request_browser_input] No toolUseId available')
      return {
        content: [{ type: 'text' as const, text: 'Unable to process browser input request - no tool use ID available.' }],
        isError: true,
      }
    }

    // A sign-in's verification page with "Try another way": which way is the
    // user's to choose. Refused once per page and session, unless the user was
    // just asked a question in this session. Read here, before the
    // synchronous check below, which must stay right before the registration.
    const sessionId = inputManager.sessionOf(toolUseId)
    const asked = inputManager.questionAnsweredWithin(QUESTION_FRESH_MS, sessionId)
    const another = asked ? null : await anotherWayOnPage()
    const refusal = another ? `${sessionId ?? ''} ${another.page}` : null
    if (another && refusal && !refusedPages.has(refusal)) {
      refusedPages.add(refusal)
      const oldest = refusedPages.size > REFUSED_PAGES_CAP ? refusedPages.values().next().value : undefined
      if (oldest !== undefined) refusedPages.delete(oldest)
      console.log(`[request_browser_input] Not handed over: the page shows "${another.name}"`)
      return {
        content: [{
          type: 'text' as const,
          text: `Not handed over: the page shows "${another.name}", so it offers other ways to verify the sign-in, and which way is the user's to choose. Open that list and have the user pick one: AskUserQuestion, one option per way (a browser subagent reports the ways to its parent agent instead). A code then goes in with request_login. Hand over with this tool only a way the user picked; if they already picked this one, call it again.`,
        }],
        isError: true,
      }
    }

    // The request is only answerable while a browser is open — the card tells
    // the user to act "in the open browser tab". Checking here (synchronously,
    // right before createPendingWithType) also closes the race with browser
    // teardown: the close routes' rejectByType only covers pendings that
    // already exist, so a close landing before this handler runs must be
    // caught by this guard rather than creating a fresh 24h pending nobody
    // can ever answer. Both this check+register and the close's
    // state-flip+reject are synchronous blocks, so they cannot interleave.
    if (!getBrowserState().active) {
      console.log('[request_browser_input] Rejected: no active browser')
      return {
        content: [{ type: 'text' as const, text: 'Browser input request cancelled: no browser is open (it may have just been closed). Open the browser again with browser_open before requesting manual input, or continue without it.' }],
        isError: true,
      }
    }

    try {
      const completion = await inputManager.createPendingWithType<string>(toolUseId, 'browser_input', {
        message: args.message,
        requirements: args.requirements,
      })

      return {
        content: [{
          type: 'text' as const,
          text: completion === 'credentials_filled'
            ? 'Credentials have been filled into the browser. Click the login or sign-in button to continue. If 2FA or another manual step appears, call request_browser_input again.'
            : 'User has completed the requested browser interaction. Take a browser snapshot to see the current state.',
        }],
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      console.log(`[request_browser_input] Request failed: ${errorMessage}`)

      return {
        content: [{ type: 'text' as const, text: `Browser input request cancelled: ${errorMessage}. The user may want to discuss the task with you.` }],
        isError: true,
      }
    }
  }
)
