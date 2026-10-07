import type { RequestDefinition } from '../requests/definition'
import { waitingInputNotification } from '../requests/definition'

export const computerUseRequestDef = {
  getNotification: waitingInputNotification('wants to control your computer'),
} satisfies RequestDefinition
