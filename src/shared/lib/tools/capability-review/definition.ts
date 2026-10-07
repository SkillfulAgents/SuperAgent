import type { RequestDefinition } from '../requests/definition'
import { waitingInputNotification } from '../requests/definition'

export const capabilityReviewRequestDef = {
  kind: 'capability_review',
  syncsAwaitingItself: true,
  getNotification: (agentName, payload) => waitingInputNotification(
    payload.capability === 'workflows'
      ? 'wants to run a workflow'
      : 'wants to launch a subagent',
  )(agentName, payload),
} satisfies RequestDefinition
