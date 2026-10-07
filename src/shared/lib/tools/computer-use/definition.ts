import type { RequestDefinition } from '../requests/definition'
import { waitingInputNotification } from '../requests/definition'

export const computerUseRequestDef = {
  kind: 'computer_use',
  syncsAwaitingItself: true,
  getNotification: waitingInputNotification('wants to control your computer'),
} satisfies RequestDefinition
