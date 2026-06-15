import { useMemo } from 'react'
import { useSettings } from '@renderer/hooks/use-settings'
import { ComposerOptions, type ComposerOptionsState } from '@renderer/components/messages/composer-options'
import { inferFamily } from '@renderer/components/messages/composer-options-popover'
import type { LlmProviderId } from '@shared/lib/config/settings'
import type { EffortLevel } from '@shared/lib/container/types'

interface SettingsModelSelectProps {
  /** Currently-selected model (a concrete model id or a bare family alias); undefined while loading. */
  model: string | undefined
  onModelChange: (model: string) => void
  /**
   * What to persist when a family is picked:
   * - `'model'` (default) → a concrete id (`claude-haiku-4-5`). Required for
   *   values the raw Anthropic SDK reads host-side, e.g. the summarizer.
   * - `'family'` → the bare alias (`haiku`). Correct for container-bound values
   *   (browser/agent) the container normalizes anyway, and avoids pinning an
   *   arbitrary version when a family maps to several models.
   */
  emit?: 'model' | 'family'
  /** Show the effort picker alongside the model. Off by default for model-only knobs. */
  includeEffort?: boolean
  effort?: EffortLevel
  onEffortChange?: (effort: EffortLevel) => void
  disabled?: boolean
}

/**
 * The composer's combined model (+ optional effort) picker, wired to read/write
 * persisted settings instead of per-message state. Shared across the LLM and
 * Browser settings tabs.
 *
 * The popover speaks in family aliases ("fable"/"opus"/"sonnet"/"haiku"), but several
 * settings consumers — notably `summarizerModel` (session-name generation, API
 * key validation) — call the Anthropic SDK directly host-side, where an alias
 * 404s ("model: haiku"). So on every pick we persist a *concrete* model id
 * resolved from the active provider's `availableModels`, keeping the current
 * version when it already matches the picked family (no needless churn).
 */
export function SettingsModelSelect({
  model,
  onModelChange,
  emit = 'model',
  includeEffort = false,
  effort = 'medium',
  onEffortChange,
  disabled,
}: SettingsModelSelectProps) {
  const { data: settings } = useSettings()
  const activeProvider = (settings?.llmProvider ?? 'anthropic') as LlmProviderId
  const providerInfo = useMemo(
    () => settings?.llmProviderStatus?.find(p => p.id === activeProvider),
    [settings, activeProvider],
  )
  const composerModels = providerInfo?.composerModels ?? []
  const availableModels = providerInfo?.availableModels ?? []

  const handleModelChange = (picked: string) => {
    const family = inferFamily(picked) ?? picked
    // `picked` is already the bare family alias (composerModels' modelId).
    if (emit === 'family') {
      onModelChange(family)
      return
    }
    // Already a concrete model of this family — keep the exact version.
    if (model && availableModels.some(m => m.value === model) && inferFamily(model) === family) {
      return
    }
    const concrete = availableModels.find(m => inferFamily(m.value) === family)?.value
    onModelChange(concrete ?? picked)
  }

  const state: ComposerOptionsState = {
    effort,
    setEffort: onEffortChange ?? (() => {}),
    model,
    setModel: handleModelChange,
    composerModels,
    toRuntimeOptions: () => ({ effort, ...(model ? { model } : {}) }),
  }

  return <ComposerOptions state={state} includeEffort={includeEffort} disabled={disabled} />
}
