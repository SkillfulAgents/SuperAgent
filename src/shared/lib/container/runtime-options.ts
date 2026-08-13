import { z } from 'zod'
import { EFFORT_LEVELS, SPEED_LEVELS, type EffortLevel, type SpeedLevel } from './types'

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
    speed: z.enum(SPEED_LEVELS).optional(),
    model: z.string().optional(),
    shouldQuery: z.boolean().optional(),
  })
  .strict()

export type RuntimeOptions = z.infer<typeof RuntimeOptionsSchema>

/**
 * PATCH-body shape for stored per-entity runtime overrides (scheduled tasks,
 * webhook triggers): each field may carry a value, be null (explicitly clears
 * the override back to the default), or be absent (left untouched). Strict so
 * an unsupported knob fails loudly instead of 200-ing as a silent no-op.
 */
export const RuntimeOptionsPatchSchema = z
  .object({
    effort: z.enum(EFFORT_LEVELS).nullish(),
    speed: z.enum(SPEED_LEVELS).nullish(),
    model: z.string().nullish(),
  })
  .strict()

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

  const speedResult = z.enum(SPEED_LEVELS).safeParse(obj.speed)
  if (speedResult.success) result.speed = speedResult.data as SpeedLevel

  if (typeof obj.model === 'string' && obj.model.length > 0) {
    result.model = obj.model
  }

  if (typeof obj.shouldQuery === 'boolean') {
    result.shouldQuery = obj.shouldQuery
  }

  return result
}

const inheritModelsSchema = z.object({
  agentModel: z.string().min(1),
})

function presentString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value
  return undefined
}

function optionalEffort(value: unknown): EffortLevel | undefined {
  const parsed = z.enum(EFFORT_LEVELS).safeParse(value)
  return parsed.success ? parsed.data : undefined
}

function optionalSpeed(value: unknown): SpeedLevel | undefined {
  const parsed = z.enum(SPEED_LEVELS).safeParse(value)
  return parsed.success ? parsed.data : undefined
}

function asRecord(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  return raw as Record<string, unknown>
}

export type RuntimeInherit = {
  model: string
  effort?: EffortLevel
  speed?: SpeedLevel
}

/**
 * Surface override → agent default → app default.
 * Junk surface/agent values are treated as unset (do not throw).
 * Effort is omitted when no rung has one. Speed stays two-rung.
 */
export function resolveRuntimeInherit(
  surface: unknown,
  agent: unknown,
  models: unknown,
): RuntimeInherit {
  const s = asRecord(surface) ?? {}
  const a = asRecord(agent) ?? {}
  const raw = asRecord(models) ?? {}
  const m = inheritModelsSchema.parse({ agentModel: raw.agentModel })

  const model = presentString(s.model) ?? presentString(a.defaultModel) ?? m.agentModel
  const effort = optionalEffort(s.effort) ?? optionalEffort(a.defaultEffort) ?? optionalEffort(raw.agentEffort)
  const speed = optionalSpeed(s.speed) ?? optionalSpeed(a.defaultSpeed)

  return {
    model,
    ...(effort ? { effort } : {}),
    ...(speed ? { speed } : {}),
  }
}

/** Snap a resolved effort to what the catalog model allows, for display only. */
export function clampEffortForDisplay(
  effort: EffortLevel | undefined,
  supported: EffortLevel[] | undefined,
): EffortLevel | undefined {
  if (!effort) return undefined
  if (!supported || supported.length === 0 || supported.includes(effort)) return effort
  return supported.includes('medium') ? 'medium' : supported[0]
}

/** Snap a resolved speed for display only. Mirrors useSpeedClamp, which always snaps to 'normal'. */
export function clampSpeedForDisplay(
  speed: SpeedLevel | undefined,
  supported: SpeedLevel[] | undefined,
): SpeedLevel | undefined {
  if (!speed) return undefined
  if (!supported || supported.length === 0 || supported.includes(speed)) return speed
  return 'normal'
}
