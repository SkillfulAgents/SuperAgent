import type { RequestDefinition } from '../requests/definition'

export const xAgentReviewRequestDef = {
  kind: 'x_agent_review',
  describeVoice: () => 'The agent needs the user to review an interaction with another agent in the application.',
  getNotification: (agentName, payload) => ({
    title: `${agentName} — Agent Action Review`,
    body: typeof payload.displayText === 'string' ? payload.displayText : 'API request review',
  }),
} satisfies RequestDefinition<'x_agent_review'>
