import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { callHost, textResult, XAgentError } from './host-client'

interface CreateAgentResult {
  slug: string
  name: string
}

export const createAgentTool = tool(
  'create_agent',
  `Create a new agent in this workspace. The user is asked to approve every create_agent call — there is no "always allow" for this tool.

After creation, you can interact with the new agent using its returned slug via invoke_agent / get_sessions / get_session_transcript.

Provide a short, descriptive name. Optionally provide a description (one line, what the agent is for) and instructions (the system prompt / CLAUDE.md body for the new agent).`,
  {
    name: z.string().min(1).describe('Short descriptive name for the new agent (e.g. "Email Triager")'),
    description: z.string().optional().describe('Optional one-line description of what the agent does'),
    instructions: z.string().optional().describe("Optional system prompt / instructions for the new agent (becomes its CLAUDE.md body)"),
  },
  async (args) => {
    try {
      const data = await callHost<CreateAgentResult>('create', args)
      return textResult(`Created agent "${data.name}" with slug "${data.slug}". You can now invoke it with invoke_agent.`)
    } catch (error) {
      const msg = error instanceof XAgentError ? error.message : String(error)
      return textResult(`Failed to create agent: ${msg}`, true)
    }
  },
)
