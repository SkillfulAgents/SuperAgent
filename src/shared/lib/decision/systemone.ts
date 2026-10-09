/** The System One wire format, spoken by TypeSafe Jev and Cloudflare Clef. */

import { z } from 'zod'
import type { DecisionAnswer, DecisionRequest, DecisionResult } from './types'

const probability = z.number().min(0).max(1)

const answerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('noul'), noul: probability }),
  z.object({
    type: z.literal('choice'),
    choice: z.string(),
    confidence: probability,
    probabilities: z.record(z.string(), probability),
  }),
  z.object({
    type: z.literal('score'),
    score: z.number(),
    confidence: probability,
    probabilities: z.record(z.string(), probability),
  }),
])

const responseSchema = z.object({ answers: z.record(z.string(), answerSchema) })

export function encodeSystemOne(request: DecisionRequest, model: string): unknown {
  const questions = Object.fromEntries(
    Object.entries(request.questions).map(([name, question]) => {
      switch (question.type) {
        case 'yesno':
          return [name, { type: 'noul', instructions: question.instructions }]
        case 'choice':
          return [name, { type: 'choice', instructions: question.instructions, criteria: question.options }]
        case 'score':
          return [name, { type: 'score', instructions: question.instructions, criteria: question.levels }]
      }
    }),
  )
  return { model, state: request.state, questions }
}

export function decodeSystemOne(body: unknown): DecisionResult {
  const { answers } = responseSchema.parse(body)
  return Object.fromEntries(
    Object.entries(answers).map(([name, answer]): [string, DecisionAnswer] => {
      switch (answer.type) {
        case 'noul':
          return [name, { type: 'yesno', probability: answer.noul }]
        case 'choice':
          return [name, { type: 'choice', choice: answer.choice, confidence: answer.confidence, probabilities: answer.probabilities }]
        case 'score': {
          const probabilities: number[] = []
          for (const [level, p] of Object.entries(answer.probabilities)) probabilities[Number(level)] = p
          return [name, { type: 'score', score: answer.score, confidence: answer.confidence, probabilities }]
        }
      }
    }),
  )
}
