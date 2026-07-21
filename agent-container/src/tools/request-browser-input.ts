import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { inputManager } from '../input-manager'
import { getBrowserState } from '../browser-state'

export const requestBrowserInputTool = tool(
  'request_browser_input',
  `Request the user to manually interact with the browser. You MUST call this tool whenever you encounter a login page, CAPTCHA, 2FA challenge, password prompt, cookie consent, or any other obstacle that requires manual user interaction. Do NOT just describe the obstacle in chat — always use this tool.

The user will see your message and requirements in the UI alongside the browser preview. The tool blocks until the user clicks "Complete" or chooses to chat with you instead. After the user completes, take a browser snapshot to see the current state.

Example:
- message: "I need you to log in to your bank account"
- requirements: ["Navigate to the login page", "Enter your credentials", "Complete 2FA if prompted"]`,
  {
    message: z.string().describe(
      "A short statement describing what the user needs to do. Never use first person or greetings. Must end with a period. Example: 'Log in to the bank account to continue the data export.'"
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
      await inputManager.createPendingWithType(toolUseId, 'browser_input', {
        message: args.message,
        requirements: args.requirements,
      })

      return {
        content: [{ type: 'text' as const, text: 'User has completed the requested browser interaction. Take a browser snapshot to see the current state.' }],
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
