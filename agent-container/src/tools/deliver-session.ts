/**
 * Deliver Session Tool — surface an agent session to the user as a clickable card.
 *
 * Sibling of deliver_file. Validation lives in the renderer (no direct DB
 * access from the container), so this is a pure pass-through that the host
 * renders into a "go to session" link.
 */

import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

export const deliverSessionTool = tool(
  'deliver_session',
  `Surface a session to the user as a clickable card in the chat. Use this when you want to point the user at an existing or newly-started agent session — e.g. "Here's the session I started" after invoking another agent, or "Here's the session I found" after searching agent history.

The user sees the card and can click to jump straight to that session.

Provide:
- session_id: the session ID (from invoke_agent, get_agent_sessions, etc.)
- agent_slug (optional): slug of the agent that owns the session. Omit when delivering one of your own sessions; pass the target slug for cross-agent sessions.
- description (optional): a short note shown above the card explaining why you're surfacing this session.`,
  {
    session_id: z.string().describe('Session ID to deliver'),
    agent_slug: z
      .string()
      .optional()
      .describe('Slug of the agent that owns the session. Omit for your own sessions.'),
    description: z
      .string()
      .optional()
      .describe('Short note shown to the user above the session card'),
  },
  async (args) => {
    const owner = args.agent_slug ? ` (agent: ${args.agent_slug})` : ''
    return {
      content: [
        {
          type: 'text' as const,
          text: `Session "${args.session_id}"${owner} has been delivered to the user. They can click the card to jump to it.`,
        },
      ],
    }
  },
)
