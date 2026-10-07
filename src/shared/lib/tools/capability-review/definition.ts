import type { RequestDefinition } from '../requests/definition'
import { waitingInputNotification } from '../requests/definition'

export const capabilityReviewRequestDef = {
  kind: 'capability_review',
  syncsAwaitingItself: true,
  describeVoice: (request) => `The agent needs approval to use ${request.capability} in the application's approval card.`,
  getNotification: (agentName, payload) => waitingInputNotification(
    payload.capability === 'workflows'
      ? 'wants to run a workflow'
      : 'wants to launch a subagent',
  )(agentName, payload),
} satisfies RequestDefinition<'capability_review'>
