import { z } from 'zod'
import type { AgentPreferences } from '@shared/lib/types/agent-preferences'
import type { EffortLevel, SpeedLevel } from './types'
import { modelSelectionFields, modelSelectionSchema, type ModelSelection } from '@shared/lib/model-selection'

/**
 * Runtime options sent alongside a message: the model selection for the turn
 * (see `@shared/lib/model-selection`) plus per-message flags.
 *
 * Defined in one place so the host API, container API, and renderer all
 * validate the same shape.
 */
export const RuntimeOptionsSchema = modelSelectionSchema
  .extend({ shouldQuery: z.boolean().optional() })
  .strict()

export type RuntimeOptions = z.infer<typeof RuntimeOptionsSchema>

/**
 * Lenient parser: returns whatever fields are individually valid and drops
 * the rest. Used at request boundaries where we'd rather honor the well-formed
 * pieces than reject the whole call.
 */
export function parseRuntimeOptions(raw: unknown): RuntimeOptions {
  const obj = asRecord(raw)
  if (!obj) return {}
  const result: Record<string, unknown> = {}
  for (const [key, schema] of Object.entries(RuntimeOptionsSchema.shape)) {
    const parsed = schema.safeParse(obj[key])
    if (parsed.success && parsed.data !== undefined) result[key] = parsed.data
  }
  return result as RuntimeOptions
}

const inheritModelsSchema = z.object({
  agentModel: z.string().min(1),
})

function presentString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value
  return undefined
}

function optionalEffort(value: unknown): EffortLevel | undefined {
  const parsed = modelSelectionFields.effort.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

function optionalSpeed(value: unknown): SpeedLevel | undefined {
  const parsed = modelSelectionFields.speed.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

function asRecord(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  return raw as Record<string, unknown>
}

/** A fully resolved selection: a model always, the rest where some rung set them. */
export type RuntimeInherit = ModelSelection & { model: string }

/**
 * Surface override → agent default → app default.
 * Junk surface values are treated as unset (do not throw).
 * Effort is omitted when no rung has one. Speed stays two-rung.
 */
export function resolveRuntimeInherit(
  surface: unknown,
  agent: Partial<AgentPreferences> | null | undefined,
  models: unknown,
): RuntimeInherit {
  const s = asRecord(surface) ?? {}
  const raw = asRecord(models) ?? {}
  const m = inheritModelsSchema.parse({ agentModel: raw.agentModel })

  const model = presentString(s.model) ?? presentString(agent?.defaultModel) ?? m.agentModel
  const effort = optionalEffort(s.effort) ?? optionalEffort(agent?.defaultEffort) ?? optionalEffort(raw.agentEffort)
  const speed = optionalSpeed(s.speed) ?? optionalSpeed(agent?.defaultSpeed)

  return {
    model,
    ...(s.model ? { llmProviderId: s.llmProviderId as string | null | undefined }
      : agent?.defaultModel ? { llmProviderId: agent.defaultLlmProviderId }
      : { llmProviderId: raw.llmProviderId as string | null | undefined }),
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

/**
 * Snap a resolved speed for display only — mirrors useSpeedClamp. A found
 * catalog model with no supportedSpeeds allows only 'normal'; an unknown
 * model leaves the speed alone (useSpeedClamp is inert without a model).
 */
export function clampSpeedForDisplay(
  speed: SpeedLevel | undefined,
  catalogModel: { supportedSpeeds?: readonly SpeedLevel[] } | undefined,
): SpeedLevel | undefined {
  if (!speed) return undefined
  if (!catalogModel) return speed
  const available = catalogModel.supportedSpeeds ?? ['normal']
  return available.includes(speed) ? speed : 'normal'
}
