export interface RequestFileInput {
  description?: string
  fileTypes?: string
}

function parseInput(input: unknown): RequestFileInput {
  return typeof input === 'object' && input !== null ? (input as RequestFileInput) : {}
}

function getSummary(input: unknown): string | null {
  return parseInput(input).description || null
}

export const requestFileDef = { displayName: 'Request File', iconName: 'Upload', parseInput, getSummary } as const
