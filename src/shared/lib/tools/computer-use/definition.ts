import type { RequestDefinition } from '../requests/definition'
import { waitingInputNotification } from '../requests/definition'

export const computerUseRequestDef = {
  kind: 'computer_use',
  syncsAwaitingItself: true,
  describeVoice: (request) => `The agent needs approval to use ${request.appName || 'the computer'} in the application's permission card.`,
  getNotification: waitingInputNotification((audience) => `wants to control ${audience.possessive} computer`),
} satisfies RequestDefinition<'computer_use'>
