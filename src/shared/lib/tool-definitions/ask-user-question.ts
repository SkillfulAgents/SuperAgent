import type { Question } from './types'

export interface AskUserQuestionInput {
  questions?: Question[]
}

/**
 * Coerce the `questions` argument into an array.
 *
 * Models occasionally emit complex tool arguments as a JSON-encoded string
 * instead of a structured value (e.g. `questions: "[{...}]"` rather than
 * `questions: [{...}]`). Left as-is, a string passes the `?.length` truthiness
 * guard but indexing it (`questions[0]`) yields a character, so `.question`
 * is undefined and downstream `.length`/`.map` access throws — crashing the
 * whole message thread. Normalize here so every consumer sees an array.
 */
function coerceQuestions(raw: unknown): Question[] | undefined {
  let value = raw
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return undefined
    }
  }
  return Array.isArray(value) ? (value as Question[]) : undefined
}

function parseInput(input: unknown): AskUserQuestionInput {
  if (typeof input !== 'object' || input === null) return {}
  return { questions: coerceQuestions((input as { questions?: unknown }).questions) }
}

function getSummary(input: unknown): string | null {
  const { questions } = parseInput(input)
  if (!questions?.length) return null
  const first = questions[0]?.question
  if (!first) return null
  const truncated = first.length > 50 ? first.slice(0, 47) + '...' : first
  return questions.length > 1 ? `${truncated} (+ ${questions.length - 1} more)` : truncated
}

export const askUserQuestionDef = { displayName: 'Question', parseInput, getSummary } as const
