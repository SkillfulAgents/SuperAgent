import { z } from 'zod'
import type { ActiveRule } from './engine'

const activeRuleSchema: z.ZodType<ActiveRule> = z.object({
  ruleId: z.string(),
  versionId: z.string(),
  version: z.number(),
  kind: z.enum(['api', 'mcp']),
  effect: z.enum(['allow', 'require']),
  name: z.string(),
  restatement: z.string(),
  patterns: z.array(z.string()),
  code: z.string(),
  toolSchemaHash: z.string().nullable(),
})

/** One live rule of a target, with the agent it is scoped to (null: every agent). */
const cachedRuleSchema = z.object({
  agentSlug: z.string().nullable(),
  active: activeRuleSchema,
})

export type CachedRule = z.infer<typeof cachedRuleSchema>

/**
 * A record of `cache:proxy-rules`. On a target's key: `rules` is the snapshot,
 * or null while there is none and the record only gives a fill a revision to
 * publish over; `epoch` is the all-targets epoch the rules were read under. On
 * the all-targets key: `epoch` is the epoch, and `rules` stays null. They share
 * one shape so that one `getMany` reads both.
 */
export const ruleCacheRecordSchema = z.object({
  epoch: z.string().nullable(),
  rules: z.array(cachedRuleSchema).nullable(),
})

export type RuleCacheRecord = z.infer<typeof ruleCacheRecordSchema>

/** "Look again": a revision and nothing else, so an event says nothing about the rules. */
export const ruleChangedEventSchema = z.object({ revision: z.string() })
