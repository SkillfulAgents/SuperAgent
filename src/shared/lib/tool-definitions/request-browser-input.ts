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

export const requestBrowserInputDef = { displayName: 'Browser Input', iconName: 'Globe', parseInput, getSummary } as const
