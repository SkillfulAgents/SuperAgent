import type { RequestDefinition } from '../requests/definition'

export const xAgentReviewRequestDef = {
  getNotification: (agentName, payload) => ({
    title: `${agentName} — Agent Action Review`,
    body: typeof payload.displayText === 'string' ? payload.displayText : 'API request review',
  }),
} satisfies RequestDefinition
