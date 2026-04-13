export interface GrepInput {
  pattern?: string
  path?: string
}

function parseInput(input: unknown): GrepInput {
  return typeof input === 'object' && input !== null ? (input as GrepInput) : {}
}

function getSummary(input: unknown): string | null {
  const { pattern, path } = parseInput(input)
  if (!pattern) return null
  const parts = [`/${pattern}/`]
  if (path) parts.push(`in ${path}`)
  return parts.join(' ')
}

export const grepDef = { displayName: 'Grep', iconName: 'Search', parseInput, getSummary } as const
