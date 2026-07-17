import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useModelConfig } from '@renderer/hooks/use-settings'
import { ComposerOptionsPopover } from './composer-options-popover'
import type { EffortLevel, SpeedLevel } from '@shared/lib/container/types'
import type { ModelDefinition } from '@shared/lib/llm-provider'

/**
 * State + presentation helpers shared between the AgentHome composer (used to
 * create a session) and the in-session MessageInput composer. Both need the
 * same per-message runtime knobs (effort, model) and the same seeding rules,
 * so we centralize:
 *   - reading the active provider's model catalog from settings
 *   - one-time seeding from `initialEffort` / `initialModel` (so late-loading
 *     session data doesn't clobber later user edits)
 *   - falling back to the user's "Default Model" setting when no initial
 *     model is supplied
 *   - rendering the two selector buttons as one toolbar block
 */

const DEFAULT_EFFORT: EffortLevel = 'medium'
const DEFAULT_SPEED: SpeedLevel = 'normal'

export interface ComposerOptionsState {
  effort: EffortLevel
  setEffort: (e: EffortLevel) => void
  speed: SpeedLevel
  setSpeed: (s: SpeedLevel) => void
  /** Raw selection — a concrete model id or a bare family alias; undefined while settings load. */
  model: string | undefined
  setModel: (m: string) => void
  /** The active provider's flat catalog of concrete model ids. */
  catalog: ModelDefinition[]
  /** Active host web-provider id (settings-derived), so the model picker's web-tools availability
   *  warning knows a configured vendor makes those tools work on any model. Undefined = native. */
  webProvider?: string
  /**
   * Pluck the runtime-options bag for an API payload. UNTOUCHED knobs (no
   * explicit user pick, no session-seeded value) are OMITTED, not serialized:
   * an adopted default sent as an explicit value would beat the server's own
   * agent-default > global resolution — wrong whenever the display is racing
   * a still-loading preferences query — and would override the actual model of
   * a session that carries none in its metadata (e.g. trigger-created).
   */
  toRuntimeOptions(): { effort?: EffortLevel; speed?: SpeedLevel; model?: string }
}

/**
 * Resolve a stored selection to its catalog entry for display: an exact
 * concrete-id match first, then a bare family alias → that family's latest.
 * Mirrors the host resolver so the UI highlights the row that will go on the wire.
 */
export function findCatalogModel(
  selection: string | undefined,
  catalog: ModelDefinition[],
): ModelDefinition | undefined {
  if (!selection) return undefined
  return (
    catalog.find((m) => m.id === selection) ??
    catalog.find((m) => m.family === selection && m.isLatest)
  )
}

export interface UseComposerOptionsArgs {
  /** Effort last used on this session, seeds the selector once if provided. */
  initialEffort?: EffortLevel
  /** Speed last used on this session, seeds the selector once if provided. */
  initialSpeed?: SpeedLevel
  /** Model last used on this session, seeds the selector once if provided. */
  initialModel?: string
  /** The agent's own default model, if set. Slots between a session's initial model and the app-wide default. */
  agentDefaultModel?: string
  /** The agent's own default effort, if set. Slots between a session's initial effort and the app-wide default. */
  agentDefaultEffort?: EffortLevel
  /** The agent's own default speed, if set. Slots between a session's initial speed and the built-in 'normal'. */
  agentDefaultSpeed?: SpeedLevel
  /**
   * Identity of the agent the defaults belong to. When it changes (quick-dispatch
   * switching agents) a locked, untouched selection unlocks and re-adopts the new
   * agent's effective defaults.
   */
  agentKey?: string
  /**
   * Whether the agent-defaults source has answered (its query settled). Until
   * settings AND this are true, an untouched selection keeps adopting the
   * effective default as the sources stream in; after both, adoption locks so a
   * background change (another window editing a default, a focus refetch) can't
   * swap a selection out from under a mid-compose user. Defaults to true for
   * callers with no agent-defaults source.
   */
  agentDefaultsReady?: boolean
  /**
   * Never lock: an untouched selection live-follows the effective default. For
   * surfaces that edit the default right next to the composer (agent home),
   * where the two must visibly stay in sync.
   */
  followDefaults?: boolean
}

export function useComposerOptions(args: UseComposerOptionsArgs = {}): ComposerOptionsState {
  const {
    initialEffort,
    initialSpeed,
    initialModel,
    agentDefaultModel,
    agentDefaultEffort,
    agentDefaultSpeed,
    agentKey,
    agentDefaultsReady = true,
    followDefaults = false,
  } = args

  const { data: modelConfig } = useModelConfig()

  // ---- Effort ----
  const [effort, setEffortState] = useState<EffortLevel>(initialEffort ?? DEFAULT_EFFORT)
  const effortSeededRef = useRef(initialEffort !== undefined)
  useEffect(() => {
    if (!effortSeededRef.current && initialEffort !== undefined) {
      setEffortState(initialEffort)
      effortSeededRef.current = true
    }
  }, [initialEffort])
  // Wrap the setter so an explicit user pick locks out the late-arriving
  // initial-seed effect — otherwise a slow `useSession` resolution can clobber
  // the user's choice if they pick before session data lands.
  const setEffort = useCallback((e: EffortLevel) => {
    effortSeededRef.current = true
    setEffortState(e)
  }, [])

  // ---- Speed ---- (same seeding/locking shape as effort)
  const [speed, setSpeedState] = useState<SpeedLevel>(initialSpeed ?? DEFAULT_SPEED)
  const speedSeededRef = useRef(initialSpeed !== undefined)
  useEffect(() => {
    if (!speedSeededRef.current && initialSpeed !== undefined) {
      setSpeedState(initialSpeed)
      speedSeededRef.current = true
    }
  }, [initialSpeed])
  const setSpeed = useCallback((sp: SpeedLevel) => {
    speedSeededRef.current = true
    setSpeedState(sp)
  }, [])

  // ---- Catalog from active provider ----
  const catalog = useMemo(() => modelConfig?.catalog ?? [], [modelConfig])
  // Fallback hierarchy: the agent's own default → user's "Default Model" →
  // provider's agent default → the catalog's latest Sonnet → first catalog
  // entry. The first non-empty wins. Aliases and concrete ids are both valid
  // wire values, so any of these is a usable selection string.
  const fallbackModel = useMemo(
    () =>
      agentDefaultModel ??
      modelConfig?.models?.agentModel ??
      modelConfig?.defaultModels?.agent ??
      catalog.find((m) => m.family === 'sonnet' && m.isLatest)?.id ??
      catalog[0]?.id,
    [agentDefaultModel, modelConfig, catalog],
  )

  // ---- Model ----
  const [model, setModelState] = useState<string | undefined>(initialModel ?? fallbackModel)
  const modelSeededRef = useRef(initialModel !== undefined)
  // Seed once when session data loads after mount.
  useEffect(() => {
    if (!modelSeededRef.current && initialModel !== undefined) {
      setModelState(initialModel)
      modelSeededRef.current = true
    }
  }, [initialModel])
  const setModel = useCallback((m: string) => {
    modelSeededRef.current = true
    setModelState(m)
  }, [])

  // ---- Default adoption ----
  // An untouched knob follows the effective default (agent default → user
  // setting → built-in) while the sources stream in: settings and agent
  // preferences resolve at different times, and quick-dispatch switches agents.
  // Once both sources have answered, adoption LOCKS (unless `followDefaults`),
  // so a later background change — another window editing a default, a focus
  // refetch — can't swap a selection out from under a mid-compose user. An
  // `agentKey` change unlocks and re-adopts for the new agent. Session-seeded
  // values and explicit user picks always win via the seeded refs.
  const adoptionLockedRef = useRef(false)
  const adoptionKeyRef = useRef(agentKey)
  const fallbackEffort =
    agentDefaultEffort ?? modelConfig?.models?.agentEffort ?? (modelConfig ? DEFAULT_EFFORT : undefined)
  const fallbackSpeed = agentDefaultSpeed ?? (modelConfig ? DEFAULT_SPEED : undefined)
  useEffect(() => {
    if (adoptionKeyRef.current !== agentKey) {
      adoptionKeyRef.current = agentKey
      adoptionLockedRef.current = false
    }
    if (adoptionLockedRef.current) return
    if (!modelSeededRef.current && fallbackModel && model !== fallbackModel) {
      setModelState(fallbackModel)
    }
    if (
      !effortSeededRef.current &&
      initialEffort === undefined &&
      fallbackEffort &&
      effort !== fallbackEffort
    ) {
      setEffortState(fallbackEffort)
    }
    if (
      !speedSeededRef.current &&
      initialSpeed === undefined &&
      fallbackSpeed &&
      speed !== fallbackSpeed
    ) {
      setSpeedState(fallbackSpeed)
    }
    if (!followDefaults && modelConfig && agentDefaultsReady) {
      adoptionLockedRef.current = true
    }
  }, [
    agentKey,
    model,
    fallbackModel,
    effort,
    fallbackEffort,
    initialEffort,
    speed,
    fallbackSpeed,
    initialSpeed,
    modelConfig,
    agentDefaultsReady,
    followDefaults,
  ])

  // Seeded refs are read at submit time: only a user pick or a session-seeded
  // value counts as an explicit choice worth putting on the wire.
  const toRuntimeOptions = useCallback(
    () => ({
      ...(effortSeededRef.current ? { effort } : {}),
      ...(speedSeededRef.current ? { speed } : {}),
      ...(modelSeededRef.current && model ? { model } : {}),
    }),
    [effort, speed, model],
  )

  return useMemo(
    () => ({
      effort,
      setEffort,
      speed,
      setSpeed,
      model,
      setModel,
      catalog,
      webProvider: modelConfig?.webProvider,
      toRuntimeOptions,
    }),
    [effort, setEffort, speed, setSpeed, model, setModel, catalog, modelConfig, toRuntimeOptions],
  )
}

interface ComposerOptionsProps {
  state: ComposerOptionsState
  disabled?: boolean
  /** Show the Effort section. Disable for model-only pickers (e.g. summarizer). */
  includeEffort?: boolean
}

/**
 * Single combined model + effort popover rendered next to the textarea in
 * both the AgentHome and in-session composers. Stateless — owned by the
 * `useComposerOptions` hook above so the parent can read the values at submit.
 */
export function ComposerOptions({ state, disabled, includeEffort }: ComposerOptionsProps) {
  return <ComposerOptionsPopover state={state} disabled={disabled} includeEffort={includeEffort} />
}
