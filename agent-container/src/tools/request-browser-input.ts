import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { inputManager } from '../input-manager'
import { getBrowserState } from '../browser-state'

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
