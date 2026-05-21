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
}

export const getSessionTranscriptTool = tool(
  'get_agent_session_transcript',
  `Read the message transcript of a session belonging to another agent. Returns a status line ('running' | 'idle' | 'awaiting_input') followed by the messages.

If sync=true and the session is currently running, the tool waits until the target agent's turn is complete before returning. Otherwise it returns the current transcript immediately.

Tool calls in the transcript are summarized — the raw tool input/output is omitted to keep the result compact.`,
  {
    slug: z.string().describe('Slug of the target agent (from list_agents)'),
    session_id: z.string().describe('Session ID (from get_agent_sessions)'),
    sync: z.boolean().optional().describe('If true, wait for the session to idle before reading. Default false.'),
  },
  async (args) => {
    try {
      const data = await callHost<TranscriptResult>('get-transcript', {
        slug: args.slug,
        sessionId: args.session_id,
        sync: args.sync ?? false,
      })
      const header = `status: ${data.status}\nmessages: ${data.messages.length}`
      if (data.messages.length === 0) {
        return textResult(`${header}\n(no messages)`)
      }
      const body = data.messages
        .map((m, i) => {
          const tool = m.toolName ? ` [${m.toolName}]` : ''
          return `--- #${i + 1} ${m.role}${tool} ---\n${m.content}`
        })
        .join('\n\n')
      return textResult(`${header}\n\n${body}`)
    } catch (error) {
      const msg = error instanceof XAgentError ? error.message : String(error)
      return textResult(`Failed to read transcript: ${msg}`, true)
    }
  },
)
