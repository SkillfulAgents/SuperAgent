import { z } from 'zod'
import type { AgentPreferences } from '@shared/lib/types/agent-preferences'
import { EFFORT_LEVELS, SPEED_LEVELS, type EffortLevel, type SpeedLevel } from './types'

/**
 * What runs an agent's turn: the LLM connection, the model on it, and the
 * effort and speed it runs at. The composer's model picker edits exactly
 * this, and everything that keeps a pick (sessions, scheduled tasks, webhook
 * triggers, chat integrations, todos, agent defaults) keeps this.
 *
 * Defined in one place so the host API, container API, and renderer all
 * carry the same shape. A new knob is added here (and to
 * `runtimeOptionsColumns` in the db schema for the tables that store one),
 * not at each place that carries it.
 */
export const RUNTIME_OPTION_KEYS = ['llmProviderId', 'model', 'effort', 'speed'] as const
export type RuntimeOptionKey = (typeof RUNTIME_OPTION_KEYS)[number]

/**
 * Runtime options in flight (a request, a session, the picker): each knob
 * absent where it was not picked, so the default applies. `llmProviderId: null`
 * is a pick that names no connection, which is not the same as leaving it out.
 */
export const RuntimeOptionsSchema = z
  .object({
    effort: z.enum(EFFORT_LEVELS).optional(),
    speed: z.enum(SPEED_LEVELS).optional(),
    model: z.string().optional(),
    llmProviderId: z.string().min(1).nullable().optional(),
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
    llmProviderId: z.string().min(1).nullish(),
  })
  .strict()

export type RuntimeOptionsPatch = z.infer<typeof RuntimeOptionsPatchSchema>

/**
 * Runtime options as a row stores them (see `runtimeOptionsColumns`), null
 * where nothing was picked. Effort and speed stay plain strings: a level
 * written by a newer build must not break this one, so they are checked where
 * they are used (`resolveRuntimeInherit`), not where they are read.
 */
export interface StoredRuntimeOptions {
  llmProviderId: string | null
  model: string | null
  effort: string | null
  speed: string | null
}

/**
 * The column values an edit writes to stored runtime options: a value sets the
 * knob, null clears it, an absent key leaves it. A model is a pick on a
 * connection, so clearing the model clears the connection too, and a model
 * picked without one stays on the connection the row already has, or goes to
 * the app's default when it has none. `appDefaultLlmProviderId` is asked only
 * for that last case, so most edits never read the settings.
 */
export async function storedRuntimeOptionsUpdate(
  patch: Partial<StoredRuntimeOptions>,
  current: Pick<StoredRuntimeOptions, 'llmProviderId'>,
  appDefaultLlmProviderId: () => Promise<string | null | undefined>,
): Promise<Partial<StoredRuntimeOptions>> {
  const update: Partial<StoredRuntimeOptions> = {}
  if ('llmProviderId' in patch) update.llmProviderId = patch.llmProviderId ?? null
  if ('model' in patch) {
    update.model = patch.model ?? null
    if (!patch.model) update.llmProviderId = null
    else if (patch.llmProviderId === undefined) {
      const appDefault = await appDefaultLlmProviderId()
      if (appDefault) update.llmProviderId = current.llmProviderId ?? appDefault
    }
  }
  if ('effort' in patch) update.effort = patch.effort ?? null
  if ('speed' in patch) update.speed = patch.speed ?? null
  return update
}

type CarriesRuntimeOptions = Partial<Record<RuntimeOptionKey, unknown>>
type PickedRuntimeOptions<T> = Pick<T, Extract<keyof T, RuntimeOptionKey>>

/**
 * Just the runtime options of something that carries them (a session, a
 * stored row, an edit on its way to the server); absent knobs stay absent.
 */
export function pickRuntimeOptions<T extends CarriesRuntimeOptions>(source: T): PickedRuntimeOptions<T> {
  const picked: CarriesRuntimeOptions = {}
  for (const key of RUNTIME_OPTION_KEYS) if (source[key] !== undefined) picked[key] = source[key]
  return picked as PickedRuntimeOptions<T>
}

/**
 * Stored runtime options as a request takes them. A level this build does not
 * know is dropped, and so is a connection with no model: a model is what is
 * picked, on a connection. A model stored with no connection is a pick of none.
 */
export function fromStoredRuntimeOptions(stored: Partial<StoredRuntimeOptions>): RuntimeOptions {
  const effort = optionalEffort(stored.effort)
  const speed = optionalSpeed(stored.speed)
  return {
    ...(stored.model ? { model: stored.model, llmProviderId: stored.llmProviderId ?? null } : {}),
    ...(effort ? { effort } : {}),
    ...(speed ? { speed } : {}),
  }
}

/** Agent preferences keep their runtime options as `defaultModel`, `defaultEffort`, …. */
export type AgentDefaultRuntimeOptions = Pick<AgentPreferences, 'defaultLlmProviderId' | 'defaultModel' | 'defaultEffort' | 'defaultSpeed'>

/** An agent's default runtime options, from its preferences: the same knobs under their own names. */
export function agentDefaultRuntimeOptions(prefs: AgentDefaultRuntimeOptions | null | undefined): RuntimeOptions {
  return {
    llmProviderId: prefs?.defaultLlmProviderId,
    model: prefs?.defaultModel,
    effort: prefs?.defaultEffort,
    speed: prefs?.defaultSpeed,
  }
}

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

  if (obj.llmProviderId === null || (typeof obj.llmProviderId === 'string' && obj.llmProviderId.length > 0)) {
    result.llmProviderId = obj.llmProviderId
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

/** Fully resolved runtime options: a model always, the rest where some rung set them. */
export type RuntimeInherit = RuntimeOptions & { model: string }

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
