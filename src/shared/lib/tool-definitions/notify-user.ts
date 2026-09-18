import { z } from 'zod'

// Host-side contract for the streamed tool arguments. The container validates
// with its own schema, but the host parses the raw stream and must not trust it.
export const notifyUserInputSchema = z.object({
  message: z.string().trim().min(1),
  title: z.string().trim().optional(),
})

export interface NotifyUserInput {
  message?: string
  title?: string
}

function parseInput(input: unknown): NotifyUserInput {
  return typeof input === 'object' && input !== null ? (input as NotifyUserInput) : {}
}

function getSummary(input: unknown): string | null {
  const { message, title } = parseInput(input)
  if (title && message) return `${title} · ${message}`
  return title || message || null
}

export const notifyUserDef = { displayName: 'Notify User', parseInput, getSummary } as const
