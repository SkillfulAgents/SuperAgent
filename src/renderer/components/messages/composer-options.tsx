import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSettings } from '@renderer/hooks/use-settings'
import { ComposerOptionsPopover } from './composer-options-popover'
import type { EffortLevel } from '@shared/lib/container/types'
import type { ComposerModel, ComposerModelFamily } from '@shared/lib/llm-provider'
import type { LlmProviderId } from '@shared/lib/config/settings'

/**
 * State + presentation helpers shared between the AgentHome composer (used to
 * create a session) and the in-session MessageInput composer. Both need the
 * same per-message runtime knobs (effort, model) and the same seeding rules,
 * so we centralize:
 *   - reading the active provider's composer models from settings
 *   - one-time seeding from `initialEffort` / `initialModel` (so late-loading
 *     session data doesn't clobber later user edits)
 *   - falling back to the user's "Default Model" setting when no initial
 *     model is supplied
 *   - rendering the two selector buttons as one toolbar block
 */

const DEFAULT_EFFORT: EffortLevel = 'high'

export interface ComposerOptionsState {
  effort: EffortLevel
  setEffort: (e: EffortLevel) => void
  /** Family alias ("opus" | "sonnet" | "haiku"), or undefined while settings load. */
  model: string | undefined
  setModel: (m: string) => void
  /** Family options for the active provider; empty for providers with no family UX. */
  composerModels: ComposerModel[]
  /** Pluck the runtime-options bag for an API payload. Drops `model` when undefined. */
  toRuntimeOptions(): { effort: EffortLevel; model?: string }
}

export interface UseComposerOptionsArgs {
  /** Effort last used on this session, seeds the selector once if provided. */
  initialEffort?: EffortLevel
  /** Model last used on this session, seeds the selector once if provided. */
  initialModel?: string
  /**
   * Preferred family for the initial model when neither `initialModel` nor a
   * prior user selection applies. Wins over the user's "Default Model"
   * setting. Used by AgentHome to start brand-new agents on Opus.
   * Only consulted while the selector hasn't been seeded yet — once the user
   * picks a model, their choice takes over.
   */
  preferredFamily?: ComposerModelFamily
}

export function useComposerOptions(args: UseComposerOptionsArgs = {}): ComposerOptionsState {
  const { initialEffort, initialModel, preferredFamily } = args

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

  // ---- Composer models from active provider ----
  const { data: settings } = useSettings()
  const activeProvider = (settings?.llmProvider ?? 'anthropic') as LlmProviderId
  const composerModels = useMemo(
    () => settings?.llmProviderStatus?.find(p => p.id === activeProvider)?.composerModels ?? [],
    [settings, activeProvider]
  )
  // Fallback hierarchy: preferred family → user's "Default Model" → provider's
  // Sonnet → first option. Preferred family wins over the user's "Default
  // Model" setting (used for the first-session-Opus default in AgentHome).
  // Family aliases are valid wire values (the container normalizes pinned
  // IDs to aliases), so `preferredFamily` itself is a usable model string.
  const fallbackModel = useMemo(() => (
    preferredFamily
    ?? settings?.models?.agentModel
    ?? composerModels.find(m => m.family === 'sonnet')?.modelId
    ?? composerModels[0]?.modelId
  ), [preferredFamily, settings, composerModels])

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
  const setModel = useCallback((m: string) => {
    modelSeededRef.current = true
    setModelState(m)
  }, [])

  const toRuntimeOptions = useCallback(
    () => ({ effort, ...(model ? { model } : {}) }),
    [effort, model]
  )

  return useMemo(
    () => ({ effort, setEffort, model, setModel, composerModels, toRuntimeOptions }),
    [effort, setEffort, model, setModel, composerModels, toRuntimeOptions]
  )
}

interface ComposerOptionsProps {
  state: ComposerOptionsState
  disabled?: boolean
}

/**
 * Single combined model + effort popover rendered next to the textarea in
 * both the AgentHome and in-session composers. Stateless — owned by the
 * `useComposerOptions` hook above so the parent can read the values at submit.
 */
export function ComposerOptions({ state, disabled }: ComposerOptionsProps) {
  return <ComposerOptionsPopover state={state} disabled={disabled} />
}
