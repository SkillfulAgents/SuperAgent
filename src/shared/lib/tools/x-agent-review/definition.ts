import type { RequestDefinition } from '../requests/definition'

export const xAgentReviewRequestDef = {
  kind: 'x_agent_review',
  getNotification: (agentName, payload) => ({
    title: `${agentName} — Agent Action Review`,
    body: typeof payload.displayText === 'string' ? payload.displayText : 'API request review',
  }),
} satisfies RequestDefinition
