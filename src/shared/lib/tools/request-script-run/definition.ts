import { waitingInputNotification, type RequestDefinition } from '../requests/definition'

export interface RequestScriptRunInput {
  script?: string
  explanation?: string
  scriptType?: string
}

function parseInput(input: unknown): RequestScriptRunInput {
  return typeof input === 'object' && input !== null ? (input as RequestScriptRunInput) : {}
}

export const SCRIPT_TYPE_LABELS: Record<string, string> = {
  applescript: 'AppleScript',
  shell: 'Shell',
  powershell: 'PowerShell',
}

function getSummary(input: unknown): string | null {
  const { scriptType, explanation } = parseInput(input)
  const typeLabel = scriptType ? SCRIPT_TYPE_LABELS[scriptType] || scriptType : ''
  const truncated = explanation && explanation.length > 60 ? explanation.slice(0, 60) + '...' : explanation
  return [typeLabel, truncated].filter(Boolean).join(': ') || null
}

export const requestScriptRunDef = {
  hideToolStatusInChat: true,
  showWaitingForInput: true,
  displayName: 'Run Script',
  parseInput,
  getSummary,
  request: {
    kind: 'script_run',
    syncsAwaitingItself: true,
    getNotification: waitingInputNotification('wants to run a script on your machine'),
    describeVoice: (request) => `The agent needs approval in the application's script card: ${request.explanation}`,
  } satisfies RequestDefinition<'script_run'>,
} as const
