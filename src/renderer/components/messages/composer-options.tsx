import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSettings } from '@renderer/hooks/use-settings'
import { ComposerOptionsPopover } from './composer-options-popover'
import type { EffortLevel } from '@shared/lib/container/types'
import type { ModelDefinition } from '@shared/lib/llm-provider'
import type { LlmProviderId } from '@shared/lib/config/settings'

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

export interface ComposerOptionsState {
  effort: EffortLevel
  setEffort: (e: EffortLevel) => void
  /** Raw selection — a concrete model id or a bare family alias; undefined while settings load. */
  model: string | undefined
  setModel: (m: string) => void
  /** The active provider's flat catalog of concrete model ids. */
  catalog: ModelDefinition[]
  /** Pluck the runtime-options bag for an API payload. Drops `model` when undefined. */
  toRuntimeOptions(): { effort: EffortLevel; model?: string }
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
  /** Model last used on this session, seeds the selector once if provided. */
  initialModel?: string
  /**
   * Bare family alias (e.g. 'opus') for the initial model when neither
   * `initialModel` nor a prior user selection applies. Wins over the user's
   * "Default Model" setting. Used by AgentHome to start brand-new agents on
   * Opus. Only consulted until the selector is seeded — once the user picks,
   * their choice takes over. The popover resolves the alias to the family's
   * latest via findCatalogModel.
   */
  preferredFamily?: string
}

export function useComposerOptions(args: UseComposerOptionsArgs = {}): ComposerOptionsState {
  const { initialEffort, initialModel, preferredFamily } = args

  const { data: settings } = useSettings()

  // ---- Effort ----
  const [effort, setEffortState] = useState<EffortLevel>(initialEffort ?? DEFAULT_EFFORT)
  const effortSeededRef = useRef(initialEffort !== undefined)
  useEffect(() => {
    if (!effortSeededRef.current && initialEffort !== undefined) {
      setEffortState(initialEffort)
      effortSeededRef.current = true
    }
  }, [initialEffort])
  // For brand-new sessions (no `initialEffort`), adopt the user's configured
  // default effort once settings load. Doesn't flip the seeded ref, so a
  // late-arriving session effort can still win, and stops once the user picks.
  const defaultEffort = settings?.models?.agentEffort
  useEffect(() => {
    if (!effortSeededRef.current && initialEffort === undefined && defaultEffort) {
      setEffortState(defaultEffort)
    }
  }, [defaultEffort, initialEffort])
  // Wrap the setter so an explicit user pick locks out the late-arriving
  // initial-seed effect — otherwise a slow `useSession` resolution can clobber
  // the user's choice if they pick before session data lands.
  const setEffort = useCallback((e: EffortLevel) => {
    effortSeededRef.current = true
    setEffortState(e)
  }, [])

  // ---- Catalog from active provider ----
  const activeProvider = (settings?.llmProvider ?? 'anthropic') as LlmProviderId
  const providerInfo = useMemo(
    () => settings?.llmProviderStatus?.find((p) => p.id === activeProvider),
    [settings, activeProvider],
  )
  const catalog = useMemo(() => providerInfo?.catalog ?? [], [providerInfo])
  // Fallback hierarchy: preferred family → user's "Default Model" → provider's
  // agent default → the catalog's latest Sonnet → first catalog entry. The
  // first non-empty wins. Aliases and concrete ids are both valid wire values,
  // so any of these (including a bare family alias) is a usable selection string.
  const fallbackModel = useMemo(
    () =>
      preferredFamily ??
      settings?.models?.agentModel ??
      providerInfo?.defaultModels?.agent ??
      catalog.find((m) => m.family === 'sonnet' && m.isLatest)?.id ??
      catalog[0]?.id,
    [preferredFamily, settings, providerInfo, catalog],
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
  // Adopt provider default if the selector is still empty by the time settings load.
  useEffect(() => {
    if (!modelSeededRef.current && model === undefined && fallbackModel) {
      setModelState(fallbackModel)
    }
  }, [model, fallbackModel])
  // When preferredFamily arrives late (e.g. after AgentHome's async session
  // list resolves and the agent turns out to have no sessions), override the
  // settings-based default — but not once the user has made an explicit pick.
  const prevPreferredRef = useRef(preferredFamily)
  useEffect(() => {
    if (preferredFamily && preferredFamily !== prevPreferredRef.current && !modelSeededRef.current) {
      setModelState(preferredFamily)
    }
    prevPreferredRef.current = preferredFamily
  }, [preferredFamily])
  const setModel = useCallback((m: string) => {
    modelSeededRef.current = true
    setModelState(m)
  }, [])

  const toRuntimeOptions = useCallback(
    () => ({ effort, ...(model ? { model } : {}) }),
    [effort, model],
  )

  return useMemo(
    () => ({ effort, setEffort, model, setModel, catalog, toRuntimeOptions }),
    [effort, setEffort, model, setModel, catalog, toRuntimeOptions],
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
