import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { inputManager } from '../input-manager'

// Host answers this after a DB write + broadcast; a silent host is a bug, so fail loud.
const NOTIFY_USER_HOST_TIMEOUT_MS = 60_000

export const notifyUserTool = tool(
  'notify_user',
  `Alert the user to something they must see, without asking them for anything.

Only for automated sessions (scheduled task, webhook trigger) that nobody is watching; the host rejects it in an interactive session, where you should simply reply in the conversation. Use it when the outcome would otherwise go unread: you could not complete the task and have nothing to ask, or you finished and the result needs a human look. The session becomes visible in the user's session list and they receive a notification pointing at it.

Do NOT use this for progress updates, for things you can still fix yourself (retry, or schedule_resume and try later), or when you need an answer (use request_secret / request_connected_account / AskUserQuestion instead — those already alert the user and wait).

Call it once, near the end of your turn. Put the actionable detail in the transcript; keep the message to one or two sentences.`,
  {
    message: z
      .string()
      .describe('One or two sentences the user will read in the notification. State what happened and what, if anything, they should do.'),
    title: z
      .string()
      .optional()
      .describe('Optional short headline (under 60 characters). Defaults to "<agent> needs your attention".'),
  },
  async (args) => {
    if (!args.message.trim()) {
      return {
        content: [{ type: 'text' as const, text: 'message cannot be empty.' }],
        isError: true,
      }
    }

    const toolUseId = inputManager.consumeCurrentToolUseId()
    if (!toolUseId) {
      return {
        content: [{ type: 'text' as const, text: 'Unable to process request — no tool use ID available.' }],
        isError: true,
      }
    }

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race([
        inputManager.createPendingWithType<string>(toolUseId, 'notify_user'),
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(
            () => reject(new Error('Timed out waiting for the host to deliver the notification')),
            NOTIFY_USER_HOST_TIMEOUT_MS,
          )
        }),
      ])
      return { content: [{ type: 'text' as const, text: result }] }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unknown error'
      return {
        content: [{ type: 'text' as const, text: `Failed to notify the user: ${msg}` }],
        isError: true,
      }
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle)
    }
  },
)
