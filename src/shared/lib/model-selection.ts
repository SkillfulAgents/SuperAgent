import { z } from 'zod'
import { EFFORT_LEVELS, SPEED_LEVELS, type EffortLevel, type SpeedLevel } from '@shared/lib/container/types'

/**
 * What runs an agent's turn: the LLM connection, the model on it, and the
 * effort and speed it runs at. The composer's model picker edits exactly
 * this, and everything that keeps a pick — sessions, scheduled tasks,
 * webhook triggers, chat integrations, todos, agent defaults — keeps this.
 *
 * A new knob is added here (and in `modelSelectionColumns` in the db schema
 * for the tables that store one), not at each place that carries it.
 */
export const modelSelectionFields = {
  llmProviderId: z.string().min(1),
  model: z.string().trim().min(1),
  effort: z.enum(EFFORT_LEVELS),
  speed: z.enum(SPEED_LEVELS),
}

export const MODEL_SELECTION_KEYS = ['llmProviderId', 'model', 'effort', 'speed'] as const
export type ModelSelectionKey = (typeof MODEL_SELECTION_KEYS)[number]

/**
 * A selection in flight, e.g. on a request: each knob absent where it was not
 * picked (the default applies). `llmProviderId: null` means the built-in
 * provider rather than a connection.
 */
export const modelSelectionSchema = z.object({
  llmProviderId: modelSelectionFields.llmProviderId.nullable().optional(),
  model: modelSelectionFields.model.optional(),
  effort: modelSelectionFields.effort.optional(),
  speed: modelSelectionFields.speed.optional(),
})
export type ModelSelection = z.infer<typeof modelSelectionSchema>

/**
 * An edit to a stored selection: a value sets the knob, `null` clears it back
 * to the default, absent leaves it as it is. Strict, so an unsupported knob
 * fails loudly instead of being dropped.
 */
export const modelSelectionPatchSchema = z
  .object({
    llmProviderId: modelSelectionFields.llmProviderId.nullish(),
    model: modelSelectionFields.model.nullish(),
    effort: modelSelectionFields.effort.nullish(),
    speed: modelSelectionFields.speed.nullish(),
  })
  .strict()
export type ModelSelectionPatch = z.infer<typeof modelSelectionPatchSchema>

/** Every knob of a selection, null where nothing is picked: a form's state, or a patch that sets them all. */
export type ModelSelectionState = { [K in ModelSelectionKey]-?: Exclude<ModelSelection[K], undefined> | null }

/** A selection as state: what `selection` picked, null for the rest. */
export function modelSelectionState(selection: ModelSelection): ModelSelectionState {
  return {
    llmProviderId: selection.llmProviderId ?? null,
    model: selection.model ?? null,
    effort: selection.effort ?? null,
    speed: selection.speed ?? null,
  }
}

/**
 * A selection as a row stores it (see `modelSelectionColumns`), null where
 * nothing was picked. Effort and speed stay plain strings: a level written by
 * a newer build must not break this one, so they are checked where they are
 * used (`resolveRuntimeInherit`), not where they are read.
 */
export interface StoredModelSelection {
  llmProviderId: string | null
  model: string | null
  effort: string | null
  speed: string | null
}

/** A stored selection's knobs as a picker or a request expects them; values this build does not know are dropped. */
export function fromStoredSelection(stored: Partial<StoredModelSelection>): ModelSelection {
  const effort = modelSelectionFields.effort.safeParse(stored.effort)
  const speed = modelSelectionFields.speed.safeParse(stored.speed)
  return {
    ...(stored.model ? { model: stored.model, llmProviderId: stored.llmProviderId ?? null } : {}),
    ...(effort.success ? { effort: effort.data as EffortLevel } : {}),
    ...(speed.success ? { speed: speed.data as SpeedLevel } : {}),
  }
}

/** Agent preferences keep a selection as `defaultModel`, `defaultEffort`, …. */
export interface AgentDefaultSelection {
  defaultLlmProviderId?: string | null
  defaultModel?: string
  defaultEffort?: EffortLevel
  defaultSpeed?: SpeedLevel
}

/** An agent's default selection, from its preferences: the same knobs under their own names. */
export function agentDefaultSelection(prefs: AgentDefaultSelection | null | undefined): ModelSelection {
  return {
    llmProviderId: prefs?.defaultLlmProviderId,
    model: prefs?.defaultModel,
    effort: prefs?.defaultEffort,
    speed: prefs?.defaultSpeed,
  }
}

/**
 * The column values an edit writes to a stored selection. A model is a pick
 * on a connection, so clearing the model clears the connection too, and a
 * model picked without one stays on the connection the row already has (or
 * `defaultLlmProviderId`, the app's default, when it has none).
 */
export function storedSelectionUpdate(
  patch: Partial<Record<ModelSelectionKey, string | null | undefined>>,
  current: Pick<StoredModelSelection, 'llmProviderId'>,
  defaultLlmProviderId: string | null | undefined,
): Partial<StoredModelSelection> {
  const update: Partial<StoredModelSelection> = {}
  if ('llmProviderId' in patch) update.llmProviderId = patch.llmProviderId ?? null
  if ('model' in patch) {
    update.model = patch.model ?? null
    if (!patch.model) update.llmProviderId = null
    else if (patch.llmProviderId === undefined && defaultLlmProviderId) update.llmProviderId = current.llmProviderId ?? defaultLlmProviderId
  }
  if ('effort' in patch) update.effort = patch.effort ?? null
  if ('speed' in patch) update.speed = patch.speed ?? null
  return update
}

type CarriesSelection = Partial<Record<ModelSelectionKey, unknown>>
type PickedSelection<T> = Pick<T, Extract<keyof T, ModelSelectionKey>>

/**
 * Just the selection knobs of something that carries one, e.g. a session, a
 * stored row, or an edit on its way to the server; absent knobs stay absent.
 */
export function pickModelSelection<T extends CarriesSelection>(source: T): PickedSelection<T> {
  const picked: CarriesSelection = {}
  for (const key of MODEL_SELECTION_KEYS) if (source[key] !== undefined) picked[key] = source[key]
  return picked as PickedSelection<T>
}
