export interface GlobInput {
  pattern?: string
  path?: string
}

function parseInput(input: unknown): GlobInput {
  return typeof input === 'object' && input !== null ? (input as GlobInput) : {}
}

function getSummary(input: unknown): string | null {
  return parseInput(input).pattern ?? null
}

export const globDef = { displayName: 'Glob', iconName: 'FolderSearch', parseInput, getSummary } as const
