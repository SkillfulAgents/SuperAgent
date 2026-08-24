import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { callHost, textResult, XAgentError } from './host-client'

interface TranscriptMessage {
  role: string
  content: string
  toolName?: string
}

interface TranscriptResult {
  status: 'running' | 'idle' | 'awaiting_input'
  messages: TranscriptMessage[]
  total: number
}

export const getSessionTranscriptTool = tool(
  'get_agent_session_transcript',
  `Read the message transcript of a session belonging to another agent. Returns a status line ('running' | 'idle' | 'awaiting_input') followed by the messages.

Pass limit to get only the most recent N messages (limit: 1 = the agent's final message). Omit limit for the whole view. Prefer a small limit.

By default the view is spoken turns only. Tool calls, tool results, and thinking are collapsed into a stub. Pass full_transcript: true to see today's compact view (tool names and tool results).

If sync=true and the session is currently running, the tool waits up to ~2 minutes for the target agent's turn to complete before returning. If the turn is still in progress after that, it returns the transcript so far with status 'running' — call again with sync=true to keep waiting. Otherwise it returns the current transcript immediately.`,
  {
    slug: z.string().describe('Slug of the target agent (from list_agents)'),
    session_id: z.string().describe('Session ID (from get_agent_sessions)'),
    sync: z.boolean().optional().describe('If true, wait for the session to idle before reading. Default false.'),
    limit: z.number().int().min(1).max(500).optional().describe('Return only the most recent N messages. Omit for the whole view.'),
    full_transcript: z.boolean().optional().describe('If true, include tool calls, tool results, and thinking. Default false.'),
  },
  async (args) => {
    try {
      const data = await callHost<TranscriptResult>('get-transcript', {
        slug: args.slug,
        sessionId: args.session_id,
        sync: args.sync ?? false,
        ...(args.limit ? { limit: args.limit } : {}),
        ...(args.full_transcript ? { fullTranscript: true } : {}),
      })
      const shown = data.messages.length
      const header = shown < data.total
        ? `status: ${data.status}\nmessages: showing last ${shown} of ${data.total}`
        : `status: ${data.status}\nmessages: ${data.total}`
      if (data.messages.length === 0) {
        return textResult(`${header}\n(no messages)`)
      }
      const offset = data.total - shown
      const body = data.messages
        .map((m, i) => {
          const tool = m.toolName ? ` [${m.toolName}]` : ''
          return `--- #${offset + i + 1} ${m.role}${tool} ---\n${m.content}`
        })
        .join('\n\n')
      return textResult(`${header}\n\n${body}`)
    } catch (error) {
      const msg = error instanceof XAgentError ? error.message : String(error)
      return textResult(`Failed to read transcript: ${msg}`, true)
    }
  },
)
