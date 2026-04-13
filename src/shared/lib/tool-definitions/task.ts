export interface TaskInput {
  subagent_type?: string
  description?: string
  prompt?: string
}

function parseInput(input: unknown): TaskInput {
  return typeof input === 'object' && input !== null ? (input as TaskInput) : {}
}

function getSummary(input: unknown): string | null {
  const { subagent_type, description } = parseInput(input)
  const parts: string[] = []
  if (subagent_type) parts.push(`[${subagent_type}]`)
  if (description) parts.push(description)
  return parts.length > 0 ? parts.join(' ') : null
}

export const taskDef = { displayName: 'Sub Agent', iconName: 'Bot', parseInput, getSummary } as const
