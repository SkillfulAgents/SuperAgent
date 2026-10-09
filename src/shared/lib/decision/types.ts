/**
 * Decision models answer typed questions about a state with probabilities
 * instead of generated text. Callers use these neutral types; each provider
 * owns its own wire format.
 */

import { z } from 'zod'

export const DECISION_PROVIDERS = ['platform', 'openai', 'typesafe', 'cloudflare'] as const
export type DecisionProviderId = (typeof DECISION_PROVIDERS)[number]

export const decisionSettingsSchema = z.object({ provider: z.enum(DECISION_PROVIDERS) }).partial()
export type DecisionSettings = z.infer<typeof decisionSettingsSchema>

export type DecisionQuestion =
  | { type: 'yesno'; instructions: string }
  | { type: 'choice'; instructions: string; options: Record<string, string> }
  /** `levels` are ordered lowest first; the answer's score indexes into them. */
  | { type: 'score'; instructions: string; levels: string[] }

export interface DecisionRequest {
  /** Text or JSON context. Images are not supported yet. */
  state: string | Record<string, unknown> | unknown[]
  questions: Record<string, DecisionQuestion>
}

export type DecisionAnswer =
  | { type: 'yesno'; probability: number }
  | { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: 'score'; score: number; confidence: number; probabilities: number[] }
  /** The model declined to answer. Never treat this as probability 0. */
  | { type: 'refused' }

export type DecisionResult = Record<string, DecisionAnswer>
