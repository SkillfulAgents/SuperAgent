import { tool } from '@anthropic-ai/claude-agent-sdk'
import { callHost, textResult, XAgentError } from './host-client'
import { listAgentMembersResultSchema } from './host-response-schemas'

export const listAgentMembersTool = tool(
  'list_agent_members',
  `List the people who are members of this agent, with each one's role, Gamut user ID and email.

Roles: an owner manages the agent, a user chats with it, a viewer can only read it. An invited member was added from a team directory and has not joined Gamut yet.

When the app runs without sign-in there are no members to list. Very large rosters are capped; a truncated listing says so.`,
  {},
  async () => {
    try {
      const data = await callHost('members', {}, listAgentMembersResultSchema)
      return textResult(data.members.length ? JSON.stringify(data, null, 2) : 'No members to list.')
    } catch (error) {
      const msg = error instanceof XAgentError ? error.message : String(error)
      return textResult(`Failed to list agent members: ${msg}`, true)
    }
  },
)
