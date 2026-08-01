/**
 * Engage Autopilot Tool - the agent's transition from interactive preflight to
 * autonomous execution.
 *
 * Only meaningful while the user has requested autopilot on the session. The
 * tool validates locally, then blocks while the HOST verifies the session is
 * actually in the `requested` state, persists the goal contract, and flips the
 * session to `engaged`. The host's resolved message is the source of truth —
 * a false local success would arm nothing.
 */

import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { inputManager } from '../input-manager'

/**
 * The process this tool flips on host-confirmed engagement. Structural (like
 * RemoteMcpInjectionTarget) so this module doesn't import claude-code.ts, and
 * bound to the OWNING process rather than a module global — the container can
 * hold other live sessions' processes and a pre-warmed spare, and flipping any
 * of those would gate the wrong session.
 */
export interface AutopilotEngagementTarget {
  noteAutopilotEngaged(): void
}

/**
 * Engagement is a fast automated host operation (metadata write), not a wait
 * on a human — a host that never responds means something is wrong; fail loud
 * instead of hanging the session.
 */
const ENGAGE_AUTOPILOT_HOST_TIMEOUT_MS = 60_000

/**
 * Factory rather than a constant: while the session is in the `requested`
 * state the tool is force-loaded into the prompt (`alwaysLoad` →
 * `_meta['anthropic/alwaysLoad']`, i.e. defer_loading: false on the wire) so
 * the preflight can call it without a ToolSearch hop; in every other state it
 * stays deferred like the rest of the user-input server. State changes always
 * rebuild the query — and with it this server — so the flag tracks the state
 * machine exactly.
 */
export const createEngageAutopilotTool = (options: {
  alwaysLoad: boolean
  getProcess?: () => AutopilotEngagementTarget | null
}) => tool(
  'engage_autopilot',
  `Engage autopilot on this session. Call this ONLY when the user has requested autopilot (you will be told in your instructions when that is the case) and you have finished preflight: accounts connected, credentials present, permissions sufficient, and the scope unambiguous.

The arguments are the goal contract an automated reviewer will judge your work against every time you stop, so state them precisely:
- goal: one-paragraph restatement of what the user wants accomplished.
- success_criteria: explicit, individually checkable conditions that define "done". Write them so an outside reviewer reading only the transcript can verify each one.
- max_iterations: optional cap on autonomous continuations before the user is brought back in (default 10).

After engaging you will not receive answers from the user: when you stop, the reviewer either lets the session rest (done), restarts you with what is still missing, or escalates to the user if you are genuinely blocked. Ask any clarifying questions BEFORE calling this tool.`,
  {
    goal: z
      .string()
      .describe('One-paragraph restatement of the task the user wants seen through.'),
    success_criteria: z
      .array(z.string())
      .min(1)
      .describe('Explicit, checkable conditions that define done. Each must be verifiable from the transcript.'),
    max_iterations: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe('Optional cap on autonomous continuations before escalating to the user (default 10).'),
  },
  async (args) => {
    console.log(`[engage_autopilot] Requesting engagement: ${args.goal.slice(0, 120)}`)

    if (!args.goal.trim() || args.success_criteria.every((c) => !c.trim())) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Goal and success_criteria must be non-empty. Restate the task and its checkable completion conditions.',
          },
        ],
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
        inputManager.createPendingWithType<string>(toolUseId, 'engage_autopilot'),
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(
            () => reject(new Error('Timed out waiting for the host to confirm engagement')),
            ENGAGE_AUTOPILOT_HOST_TIMEOUT_MS,
          )
        }),
      ])

      // Host confirmed: flip the local process state so the ask-the-user tool
      // gate applies for the remainder of THIS turn (the host's authoritative
      // state otherwise only reaches the process with the next message).
      options.getProcess?.()?.noteAutopilotEngaged()

      return {
        content: [{ type: 'text' as const, text: result }],
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unknown error'
      return {
        content: [{ type: 'text' as const, text: `Failed to engage autopilot: ${msg}` }],
        isError: true,
      }
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle)
    }
  },
  { alwaysLoad: options.alwaysLoad }
)
