export interface EngageAutopilotInput {
  goal?: string
  success_criteria?: string[]
  max_iterations?: number
}

function parseInput(input: unknown): EngageAutopilotInput {
  return typeof input === 'object' && input !== null ? (input as EngageAutopilotInput) : {}
}

function getSummary(input: unknown): string | null {
  return parseInput(input).goal || null
}

export const engageAutopilotDef = { displayName: 'Engage Autopilot', parseInput, getSummary } as const
