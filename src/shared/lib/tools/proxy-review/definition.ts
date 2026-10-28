import type { RequestDefinition } from '../requests/definition'

export const proxyReviewRequestDef = {
  kind: 'proxy_review',
  describeVoice: (request) => `The agent needs the user to review a ${request.toolkit} action in the application's approval card.`,
  getNotification: (agentName, payload) => ({
    title: `${agentName} — API Request Review`,
    body: typeof payload.displayText === 'string' ? payload.displayText : 'API request review',
  }),
} satisfies RequestDefinition<'proxy_review'>
