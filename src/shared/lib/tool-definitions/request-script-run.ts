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

export const requestScriptRunDef = { displayName: 'Run Script', iconName: 'Terminal', parseInput, getSummary } as const
