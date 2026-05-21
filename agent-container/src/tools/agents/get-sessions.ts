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
  total: number
  offset: number
  limit: number
}

export const getSessionsTool = tool(
  'get_agent_sessions',
  `List the sessions of another agent in this workspace, newest first. Returns each session's id, name, last activity time, and whether it is currently running.

Returns up to 50 sessions by default. If more exist, the response includes a hint with the next offset to pass back in for the next page.

Use the returned session ID with get_session_transcript to read the conversation, or with invoke_agent to send a follow-up message into an existing session.`,
  {
    slug: z.string().describe('Slug of the target agent (from list_agents)'),
    limit: z.number().int().min(1).max(200).optional().describe('Max sessions to return (default 50, max 200)'),
    offset: z.number().int().min(0).optional().describe('Number of sessions to skip from the newest (default 0)'),
  },
  async (args) => {
    try {
      const data = await callHost<GetSessionsResult>('get-sessions', {
        slug: args.slug,
        limit: args.limit,
        offset: args.offset,
      })
      if (data.total === 0) {
        return textResult(`Agent "${args.slug}" has no sessions.`)
      }
      const lines = data.sessions.map((s) => {
        const running = s.isRunning ? ' [running]' : ''
        return `- ${s.id}${running} · ${s.name} · ${s.messageCount} msgs · last ${s.lastActivityAt}`
      })
      const shown = data.offset + data.sessions.length
      const header = `Sessions for "${args.slug}" (${data.sessions.length} of ${data.total}):`
      const more = shown < data.total
        ? `\n\n(${data.total - shown} more sessions — call again with offset=${shown} to see them)`
        : ''
      return textResult(`${header}\n${lines.join('\n')}${more}`)
    } catch (error) {
      const msg = error instanceof XAgentError ? error.message : String(error)
      return textResult(`Failed to list sessions: ${msg}`, true)
    }
  },
)
