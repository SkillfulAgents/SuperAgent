import type { Question } from './types'

export interface AskUserQuestionInput {
  questions?: Question[]
}

function parseInput(input: unknown): AskUserQuestionInput {
  return typeof input === 'object' && input !== null ? (input as AskUserQuestionInput) : {}
}

function getSummary(input: unknown): string | null {
  const { questions } = parseInput(input)
  if (!questions?.length) return null
  const first = questions[0].question
  const truncated = first.length > 50 ? first.slice(0, 47) + '...' : first
  return questions.length > 1 ? `${truncated} (+ ${questions.length - 1} more)` : truncated
}

export const askUserQuestionDef = { displayName: 'Question', iconName: 'MessageCircleQuestion', parseInput, getSummary } as const
