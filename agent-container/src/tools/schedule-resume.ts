/**
 * Schedule Resume Tool - Lets the agent put the CURRENT session to sleep and
 * have it automatically resumed later, with full context.
 *
 * This is deliberately a separate tool from schedule_task: schedule_task spawns
 * an independent future session; schedule_resume continues THIS conversation.
 * The actual persistence is handled by the API server, which intercepts this
 * tool call and saves the wake to the database (same blocking contract as
 * schedule_task).
 */

import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { inputManager } from '../input-manager'

/**
 * How long to wait for the host to confirm the wake before giving up. Like
 * schedule_task, this blocks only on a fast automated host operation (a DB
 * write) — a host that never responds means something is wrong, so fail loud
 * instead of hanging the session.
 */
const SCHEDULE_RESUME_HOST_TIMEOUT_MS = 60_000

export const scheduleResumeTool = tool(
  'schedule_resume',
  `Pause this session and automatically resume THIS SAME conversation at a future time, with full context preserved.

Use this when you are waiting on something external and want to check back later in the same conversation — for example:
- You emailed someone and want to check for a reply tomorrow morning
- You submitted something for review and want to check its status in 72 hours
- You kicked off a long-running external process and want to check on it later

How it works: after this tool succeeds, END YOUR TURN. The session goes idle (it costs nothing and survives restarts while sleeping) and is resumed at the scheduled time with a system message that echoes your note back to you. If what you were waiting for still hasn't happened when you wake, you can call schedule_resume again to check later.

wakeTime accepts natural language: "tomorrow 9am", "in 72 hours", "next monday 8am", "2027-03-15 14:00".

Constraints:
- A session holds at most ONE pending wake — scheduling a new one replaces the previous one.
- One-shot only (no recurring wakes). For recurring checks, re-schedule on each wake, or use schedule_task if the work doesn't need this conversation's context.

This is different from schedule_task, which starts a NEW session with no memory of this conversation. Prefer schedule_resume when the follow-up needs the context you have right now.`,
  {
    wakeTime: z
      .string()
      .describe(
        'When to resume this session. Natural language, e.g. "tomorrow 9am", "in 72 hours", "next monday". Interpreted in the timezone parameter (or the owner\'s timezone if omitted).'
      ),
    note: z
      .string()
      .describe(
        'Why you are pausing and what to check when you wake. Echoed back to you verbatim in the resume message — write it as a note to your future self.'
      ),
    timezone: z
      .string()
      .optional()
      .describe(
        'Optional IANA timezone for interpreting wakeTime (e.g. "America/New_York"). Defaults to the owner\'s timezone.'
      ),
  },
  async (args) => {
    console.log(`[schedule_resume] Scheduling session resume: ${args.wakeTime}`)

    if (!args.wakeTime.trim()) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'wakeTime cannot be empty. Provide a time like "tomorrow 9am" or "in 72 hours".',
          },
        ],
        isError: true,
      }
    }

    if (!args.note.trim()) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'note cannot be empty. Write a note to your future self: why you are pausing and what to check on wake.',
          },
        ],
        isError: true,
      }
    }

    // Blocking: the host persists the wake and resolves this tool only after it
    // is actually saved, so the agent is never told a false success.
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
        inputManager.createPendingWithType<string>(toolUseId, 'schedule_resume'),
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(
            () => reject(new Error('Timed out waiting for the host to confirm the scheduled resume')),
            SCHEDULE_RESUME_HOST_TIMEOUT_MS,
          )
        }),
      ])

      return {
        content: [{ type: 'text' as const, text: result }],
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unknown error'
      return {
        content: [{ type: 'text' as const, text: `Failed to schedule resume: ${msg}` }],
        isError: true,
      }
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle)
    }
  }
)
