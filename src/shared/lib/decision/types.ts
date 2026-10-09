/**
 * Decision models answer typed questions about a state with probabilities
 * instead of generated text. Callers use these neutral types; each provider
 * owns its own wire format.
 */

export const DECISION_PROVIDERS = ['platform', 'openai', 'typesafe', 'cloudflare'] as const
export type DecisionProviderId = (typeof DECISION_PROVIDERS)[number]

/** Models each provider serves, default first. Shared with the settings UI. */
export const DECISION_MODELS: Record<DecisionProviderId, readonly string[]> = {
  platform: ['gpt-6-luna'],
  openai: ['gpt-6-luna'],
  typesafe: ['jev-latest', 'jev-1.13.0'],
  cloudflare: ['clef', 'clef-flash'],
}

export interface DecisionSettings {
  provider?: DecisionProviderId
  /** Provider model id; the provider's default when unset. */
  model?: string
}

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
