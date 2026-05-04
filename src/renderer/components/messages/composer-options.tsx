import { useEffect, useMemo, useRef, useState } from 'react'
import { useSettings } from '@renderer/hooks/use-settings'
import { EffortSelector } from './effort-selector'
import { ModelSelector } from './model-selector'
import type { EffortLevel } from '@shared/lib/container/types'
import type { ComposerModel } from '@shared/lib/llm-provider'
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
  /** Pinned model ID (e.g. "claude-opus-4-7"), or undefined while settings load. */
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
}

export function useComposerOptions(args: UseComposerOptionsArgs = {}): ComposerOptionsState {
  const { initialEffort, initialModel } = args

  // ---- Effort ----
  const [effort, setEffort] = useState<EffortLevel>(initialEffort ?? DEFAULT_EFFORT)
  const effortSeededRef = useRef(initialEffort !== undefined)
  useEffect(() => {
    if (!effortSeededRef.current && initialEffort !== undefined) {
      setEffort(initialEffort)
      effortSeededRef.current = true
    }
  }, [initialEffort])

  // ---- Composer models from active provider ----
  const { data: settings } = useSettings()
  const activeProvider = (settings?.llmProvider ?? 'anthropic') as LlmProviderId
  const composerModels = useMemo(
    () => settings?.llmProviderStatus?.find(p => p.id === activeProvider)?.composerModels ?? [],
    [settings, activeProvider]
  )
  // Fallback hierarchy: user's "Default Model" → provider's Sonnet → first option.
  const fallbackModel = useMemo(() => (
    settings?.models?.agentModel
    ?? composerModels.find(m => m.family === 'sonnet')?.modelId
    ?? composerModels[0]?.modelId
  ), [settings, composerModels])

  // ---- Model ----
  const [model, setModel] = useState<string | undefined>(initialModel ?? fallbackModel)
  const modelSeededRef = useRef(initialModel !== undefined)
  // Seed once when session data loads after mount.
  useEffect(() => {
    if (!modelSeededRef.current && initialModel !== undefined) {
      setModel(initialModel)
      modelSeededRef.current = true
    }
  }, [initialModel])
  // Adopt provider default if the selector is still empty by the time settings load.
  useEffect(() => {
    if (!modelSeededRef.current && model === undefined && fallbackModel) {
      setModel(fallbackModel)
    }
  }, [model, fallbackModel])

  return {
    effort,
    setEffort,
    model,
    setModel,
    composerModels,
    toRuntimeOptions: () => ({ effort, ...(model ? { model } : {}) }),
  }
}

interface ComposerOptionsProps {
  state: ComposerOptionsState
  disabled?: boolean
}

/**
 * The two-button toolbar (effort + model) rendered next to the textarea in
 * both the AgentHome and in-session composers. Stateless — owned by the
 * `useComposerOptions` hook above so the parent can read the values at submit.
 */
export function ComposerOptions({ state, disabled }: ComposerOptionsProps) {
  return (
    <>
      <EffortSelector value={state.effort} onChange={state.setEffort} disabled={disabled} />
      <ModelSelector
        value={state.model}
        onChange={state.setModel}
        options={state.composerModels}
        disabled={disabled}
      />
    </>
  )
}
