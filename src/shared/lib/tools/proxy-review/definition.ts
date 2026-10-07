import type { RequestDefinition } from '../requests/definition'

export const proxyReviewRequestDef = {
  getNotification: (agentName, payload) => ({
    title: `${agentName} — API Request Review`,
    body: typeof payload.displayText === 'string' ? payload.displayText : 'API request review',
  }),
} satisfies RequestDefinition
