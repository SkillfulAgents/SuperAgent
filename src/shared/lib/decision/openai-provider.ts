import { z } from 'zod'
import { BaseDecisionProvider } from './decision-provider'
import type { DecisionAnswer, DecisionProviderId, DecisionRequest, DecisionResult } from './types'

const probability = z.number().min(0).max(1)

const answerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('predicate'), name: z.string(), probability }),
  z.object({
    type: z.literal('choice'),
    name: z.string(),
    choice: z.string(),
    confidence: probability,
    probabilities: z.array(z.object({ value: z.string(), probability })),
  }),
  z.object({
    type: z.literal('score'),
    name: z.string(),
    score: z.number(),
    confidence: probability,
    probabilities: z.array(z.object({ value: z.number().int().min(0), probability })),
  }),
  z.object({ type: z.literal('refusal'), name: z.string() }),
])

const responseSchema = z.object({ answers: z.array(answerSchema) })

/** OpenAI Decisions (`POST /v1/decisions`): named questions in an array, `predicate` for yes/no. */
export class OpenaiDecisionProvider extends BaseDecisionProvider {
  readonly id: DecisionProviderId = 'openai'
  readonly name: string = 'OpenAI'
  readonly model = 'gpt-6-luna'
  // Shared with OpenAI voice: one OpenAI key serves both.
  protected readonly settingsKeyField = 'openaiApiKey' as const
  protected readonly envVarName = 'OPENAI_API_KEY'

  /** Where the OpenAI endpoints live; a proxying subclass points this elsewhere. */
  protected apiBaseUrl(): string {
    return 'https://api.openai.com/v1'
  }

  protected endpointUrl(): string {
    return `${this.apiBaseUrl()}/decisions`
  }

  protected keyCheckUrl(): string {
    return `${this.apiBaseUrl()}/models`
  }

  protected encode(request: DecisionRequest, model: string): unknown {
    const questions = Object.entries(request.questions).map(([name, question]) => {
      switch (question.type) {
        case 'yesno':
          return { type: 'predicate', name, instructions: question.instructions }
        case 'choice':
          return {
            type: 'choice',
            name,
            instructions: question.instructions,
            choices: Object.entries(question.options).map(([value, description]) => ({ value, description })),
          }
        case 'score':
          return { type: 'score', name, instructions: question.instructions, levels: question.levels.map(label => ({ label })) }
      }
    })
    // `input` is a string or user messages, not a JSON value.
    const input = typeof request.state === 'string' ? request.state : JSON.stringify(request.state)
    return { model, input, questions }
  }

  protected decode(body: unknown): DecisionResult {
    const { answers } = responseSchema.parse(body)
    return Object.fromEntries(
      answers.map((answer): [string, DecisionAnswer] => {
        switch (answer.type) {
          case 'predicate':
            return [answer.name, { type: 'yesno', probability: answer.probability }]
          case 'choice':
            return [answer.name, {
              type: 'choice',
              choice: answer.choice,
              confidence: answer.confidence,
              probabilities: Object.fromEntries(answer.probabilities.map(p => [p.value, p.probability])),
            }]
          case 'score': {
            const probabilities: number[] = []
            for (const p of answer.probabilities) probabilities[p.value] = p.probability
            return [answer.name, { type: 'score', score: answer.score, confidence: answer.confidence, probabilities }]
          }
          case 'refusal':
            return [answer.name, { type: 'refused' }]
        }
      }),
    )
  }
}
