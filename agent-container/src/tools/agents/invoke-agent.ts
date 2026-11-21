import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { callHost, textResult, XAgentError } from './host-client'
import { invokeResultSchema } from './host-response-schemas'

export function makeInvokeAgentTool(getCallerSessionId: () => string) {
  return tool(
    'invoke_agent',
    `Send a message to an agent in this workspace, including your own. Omit slug to target your own agent, for example to start a worker session or continue one of your own sessions; that needs no approval.

If session_id is omitted, a new session is started on the target agent. If session_id is provided, the message is appended to that existing session. If that session is in the middle of a turn, the message joins the turn, the way a user's follow-up does.

If sync=true, the tool waits up to ~2 minutes for the target agent's turn to finish and returns its last message. If the target is still working after that, the call returns status 'running' with the session_id — the invocation was delivered and is in progress; do NOT re-invoke (that would start a duplicate run), poll get_agent_session_transcript instead. If sync=false (default), the tool returns immediately with status 'running' and you can later read the transcript with get_agent_session_transcript.

Use list_agents first to discover other agents' slugs. For your own sessions, read progress with /opt/gamut/bin/read-session.py <session_id> instead of get_agent_session_transcript, and rerun it to see new output.

Note: sessions started by invoke_agent cannot themselves invoke agents — invocation is one hop deep.`,
    {
      slug: z.string().optional().describe('Slug of the target agent (from list_agents). Omit to target your own agent.'),
      prompt: z.string().min(1).describe('Message to send to the target agent'),
      session_id: z.string().optional().describe('Optional existing session ID to continue. Omit to start a new session.'),
      sync: z.boolean().optional().describe('If true, wait for the target agent to finish its turn and return its final message. Default false.'),
      attachments: z.array(z.string()).max(10).optional().describe('Up to 10 regular files under the caller\'s /workspace to send with the prompt. Paths may be absolute /workspace/... paths or workspace-relative paths.'),
      model: z.string().optional().describe('Optional model for a new session: a model id or a family name such as "sonnet", checked against the target agent\'s account, or the account named in connection. An unknown model is rejected with that account\'s model ids. If not specified, uses the target agent\'s default. Leave out model, effort and speed unless the user asked for a specific one. Not allowed with session_id.'),
      connection: z.string().optional().describe('Optional account for model, by its id or its exact name in Settings → Model Providers. Leave it out to use the agent\'s own account. Name an account only when the user asked for one or the model is not on the agent\'s own account. Not allowed with session_id.'),
      effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional().describe('Optional effort level for a new session. If not specified, uses the target agent\'s default. Not allowed with session_id.'),
      speed: z.enum(['slow', 'normal', 'fast']).optional().describe('Optional processing-speed tier for a new session. If not specified, uses the target agent\'s default. Not allowed with session_id.'),
    },
    async (args) => {
      try {
        const body: Record<string, unknown> = {
          slug: args.slug,
          prompt: args.prompt,
        }
        if (args.session_id) body.sessionId = args.session_id
        if (args.sync) body.sync = true
        if (args.attachments !== undefined) body.attachments = args.attachments
        if (args.model) body.model = args.model
        if (args.connection) body.connection = args.connection
        if (args.effort) body.effort = args.effort
        if (args.speed) body.speed = args.speed

        const data = await callHost('invoke', body, invokeResultSchema, { callerSessionId: getCallerSessionId() })
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
