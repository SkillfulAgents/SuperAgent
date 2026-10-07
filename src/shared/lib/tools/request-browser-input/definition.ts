import { waitingInputNotification, type RequestDefinition } from '../requests/definition'

export interface RequestBrowserInputInput {
  message?: string
  requirements?: string[]
}

function parseInput(input: unknown): RequestBrowserInputInput {
  return typeof input === 'object' && input !== null ? (input as RequestBrowserInputInput) : {}
}

function getSummary(input: unknown): string | null {
  const { message } = parseInput(input)
  if (!message) return null
  return message.length > 60 ? message.slice(0, 57) + '...' : message
}

export const requestBrowserInputDef = {
  hideToolStatusInChat: true,
  showWaitingForInput: true,
  displayName: 'Browser Input',
  rendererDisplayName: 'Request Browser Input',
  parseInput,
  getSummary,
  request: {
    kind: 'browser_input',
    getNotification: waitingInputNotification('needs your browser input'),
    describeVoice: (request) => `The agent needs the user to complete an action in the browser: ${request.message}${request.requirements.length ? ` Requirements: ${request.requirements.join(', ')}.` : ''}`,
  } satisfies RequestDefinition<'browser_input'>,
} as const
