import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { callHost, textResult, XAgentError } from './host-client'

interface SessionEntry {
  id: string
  name: string
  createdAt: string
  lastActivityAt: string
  messageCount: number
  isRunning: boolean
}

interface GetSessionsResult {
  sessions: SessionEntry[]
}

export const getSessionsTool = tool(
  'get_agent_sessions',
  `List the sessions of another agent in this workspace. Returns each session's id, name, last activity time, and whether it is currently running.

Use the returned session ID with get_session_transcript to read the conversation, or with invoke_agent to send a follow-up message into an existing session.`,
  {
    slug: z.string().describe('Slug of the target agent (from list_agents)'),
  },
  async (args) => {
    try {
      const data = await callHost<GetSessionsResult>('get-sessions', { slug: args.slug })
      if (data.sessions.length === 0) {
        return textResult(`Agent "${args.slug}" has no sessions.`)
      }
      const lines = data.sessions.map((s) => {
        const running = s.isRunning ? ' [running]' : ''
        return `- ${s.id}${running} · ${s.name} · ${s.messageCount} msgs · last ${s.lastActivityAt}`
      })
      return textResult(`Sessions for "${args.slug}" (${data.sessions.length}):\n${lines.join('\n')}`)
    } catch (error) {
      const msg = error instanceof XAgentError ? error.message : String(error)
      return textResult(`Failed to list sessions: ${msg}`, true)
    }
  },
)
