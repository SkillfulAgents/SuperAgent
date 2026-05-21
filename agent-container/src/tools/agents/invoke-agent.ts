import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { callHost, textResult, XAgentError } from './host-client'

interface InvokeResult {
  sessionId: string
  status: 'running' | 'completed'
  lastMessage?: string
  error?: string
}

export function makeInvokeAgentTool(getCallerSessionId: () => string) {
  return tool(
    'invoke_agent',
    `Send a message to another agent in this workspace.

If session_id is omitted, a new session is started on the target agent. If session_id is provided, the message is appended to that existing session — the session must exist and not currently be running (use get_session_transcript with sync to wait).

If sync=true, the tool waits for the target agent's turn to finish and returns its last message. If sync=false (default), the tool returns immediately with status 'running' and you can later read the transcript with get_session_transcript.

Use list_agents first to discover available slugs.

Note: sessions started by another agent cannot themselves invoke other agents — invocation is one hop deep.`,
    {
      slug: z.string().describe('Slug of the target agent (from list_agents)'),
      prompt: z.string().min(1).describe('Message to send to the target agent'),
      session_id: z.string().optional().describe('Optional existing session ID to continue. Omit to start a new session.'),
      sync: z.boolean().optional().describe('If true, wait for the target agent to finish its turn and return its final message. Default false.'),
    },
    async (args) => {
      try {
        const body: Record<string, unknown> = {
          slug: args.slug,
          prompt: args.prompt,
        }
        if (args.session_id) body.sessionId = args.session_id
        if (args.sync) body.sync = true

        const data = await callHost<InvokeResult>('invoke', body, { callerSessionId: getCallerSessionId() })
        const lines = [`session_id: ${data.sessionId}`, `status: ${data.status}`]
        // Use !== undefined so an empty-string lastMessage is still surfaced
        // (compactMessage now returns "[no text response]" rather than "" for
        // empty turns, but be defensive — empty string is still semantically
        // distinct from "host omitted the field").
        if (data.lastMessage !== undefined) {
          lines.push('', '--- last message from agent ---', data.lastMessage)
        }
        if (data.error) {
          lines.push('', `note: ${data.error}`)
        }
        return textResult(lines.join('\n'))
      } catch (error) {
        const msg = error instanceof XAgentError ? error.message : String(error)
        return textResult(`Failed to invoke agent: ${msg}`, true)
      }
    },
  )
}
