import { z } from 'zod'
import { EFFORT_LEVELS, type EffortLevel } from './types'

/**
 * Runtime options sent alongside a message: the per-invocation knobs that
 * control how the agent thinks (effort) and which model serves the response.
 *
 * Defined in one place so the host API, container API, and renderer all
 * validate the same shape. Add new optional fields here as they appear
 * (e.g. thinkingBudget, maxOutputTokens overrides).
 */
export const RuntimeOptionsSchema = z
  .object({
    effort: z.enum(EFFORT_LEVELS).optional(),
    model: z.string().optional(),
    shouldQuery: z.boolean().optional(),
  })
  .strict()

export type RuntimeOptions = z.infer<typeof RuntimeOptionsSchema>

/**
 * Lenient parser: returns whatever fields are individually valid and drops
 * the rest. Used at request boundaries where we'd rather honor the well-formed
 * pieces than reject the whole call.
 */
export function parseRuntimeOptions(raw: unknown): RuntimeOptions {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const obj = raw as Record<string, unknown>

  const result: RuntimeOptions = {}
  const effortResult = z.enum(EFFORT_LEVELS).safeParse(obj.effort)
  if (effortResult.success) result.effort = effortResult.data as EffortLevel

  if (typeof obj.model === 'string' && obj.model.length > 0) {
    result.model = obj.model
  }

  if (typeof obj.shouldQuery === 'boolean') {
    result.shouldQuery = obj.shouldQuery
  }

  return result
}
