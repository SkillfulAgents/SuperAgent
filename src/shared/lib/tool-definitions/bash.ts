export interface BashInput {
  command?: string
  description?: string
}

function parseInput(input: unknown): BashInput {
  return typeof input === 'object' && input !== null ? (input as BashInput) : {}
}

function getSummary(input: unknown): string | null {
  const { command, description } = parseInput(input)
  if (description) return description
  if (command) {
    const firstLine = command.split('\n')[0]
    return firstLine.length > 50 ? `$ ${firstLine.slice(0, 47)}...` : `$ ${firstLine}`
  }
  return null
}

export const bashDef = { displayName: 'Bash', iconName: 'Terminal', parseInput, getSummary } as const
