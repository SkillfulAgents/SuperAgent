import { waitingInputNotification, type RequestDefinition } from '../requests/definition'
import { summarizeLoginFields, type LoginFieldInput } from './login-request'

export interface RequestLoginInput {
  message?: string
  fields?: LoginFieldInput[]
  submit?: string
}

function parseInput(input: unknown): RequestLoginInput {
  return typeof input === 'object' && input !== null ? (input as RequestLoginInput) : {}
}

function getSummary(input: unknown): string | null {
  const { message } = parseInput(input)
  if (!message) return null
  return message.length > 60 ? message.slice(0, 57) + '...' : message
}

export const requestLoginDef = {
  hideToolStatusInChat: true,
  showWaitingForInput: true,
  displayName: 'Sign In',
  rendererDisplayName: 'Request Sign In',
  parseInput,
  getSummary,
  request: {
    kind: 'login',
    getNotification: waitingInputNotification('needs you to sign in'),
    describeVoice: (request) => {
      const fields = summarizeLoginFields(request.fields).map((field) => field.label.toLowerCase())
      return `The agent needs the user to sign in through the form in the app${fields.length ? ` (${fields.join(', ')})` : ''}: ${request.message} Credentials can't be given by voice.`
    },
  } satisfies RequestDefinition<'login'>,
} as const
