/**
 * Shapes shared by the host and the renderer: an agent's rule proposal as it
 * rides on a proxy review, and the per-rule outcomes a review card shows.
 * Pure zod — no node imports — so the renderer can parse envelopes with it.
 */
import { z } from 'zod'

export const reviewRuleOutcomeSchema = z.object({
  ruleId: z.string(),
  version: z.number(),
  effect: z.enum(['allow', 'require']).default('allow'),
  name: z.string().optional(),
  restatement: z.string(),
  result: z.string(),
  detail: z.string().optional(),
})

export const ruleProposalSchema = z.object({
  ruleKind: z.enum(['api', 'mcp']),
  targetId: z.string(),
  targetName: z.string(),
  appliesTo: z.enum(['agent', 'all_agents']),
  effect: z.enum(['allow', 'require']).default('allow'),
  description: z.string(),
  /** Name and restatement are written from the code alone; the agent never
   * sees or supplies them. */
  name: z.string().optional(),
  restatement: z.string(),
  patterns: z.array(z.string()),
  code: z.string(),
  tests: z.array(z.object({
    name: z.string(),
    expect: z.boolean(),
    passed: z.boolean(),
    result: z.string(),
  })),
  coverage: z.array(z.string()),
  warnings: z.array(z.string()),
  /** Set when the proposal replaces an existing rule's current version. */
  replacesRuleId: z.string().optional(),
  /** Set when the agent asks to delete this rule (the fields describe it). */
  deletesRuleId: z.string().optional(),
})

export type RuleEffectView = 'allow' | 'require'

/** Short label for a rule's effect. */
export function ruleEffectLabel(effect: RuleEffectView | string | undefined): string {
  return effect === 'require' ? 'Requires review' : 'Skips review'
}

/** What a test case's expected answer means for the request, per effect. */
export function ruleTestExpectLabel(effect: RuleEffectView | string | undefined, expect: boolean): string {
  if (effect === 'require') return expect ? 'goes through' : 'held for review'
  return expect ? 'skips review' : 'stays in review'
}

/** Whether a require rule held the reviewed request (so "always allow" can't help). */
export function heldByRequireRule(outcomes: Array<{ effect?: string; result: string }> | undefined): boolean {
  return !!outcomes?.some((o) => o.effect === 'require' && o.result !== 'true')
}

export type RuleProposalReview = z.infer<typeof ruleProposalSchema>
export type ReviewRuleOutcomeView = z.infer<typeof reviewRuleOutcomeSchema>

export function parseRuleProposal(value: unknown): RuleProposalReview | undefined {
  const parsed = ruleProposalSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

export function parseRuleOutcomes(value: unknown): ReviewRuleOutcomeView[] | undefined {
  const parsed = z.array(reviewRuleOutcomeSchema).safeParse(value)
  return parsed.success && parsed.data.length > 0 ? parsed.data : undefined
}
