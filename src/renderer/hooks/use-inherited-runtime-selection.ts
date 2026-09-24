import { resolveSelection } from '@shared/lib/llm-provider/connection-schema'
import { useCallback, useMemo } from 'react'
import { useAgentPreferences } from '@renderer/hooks/use-agent-preferences'
import { useModelSettings } from '@renderer/hooks/use-settings'
import { findCatalogModel } from '@renderer/components/messages/model-family-list'
import {
  clampEffortForDisplay,
  clampSpeedForDisplay,
  resolveRuntimeInherit,
} from '@shared/lib/container/runtime-options'
import type { ModelDefinition } from '@shared/lib/llm-provider'
import type { EffortLevel, SpeedLevel } from '@shared/lib/container/types'
import type { LlmProviderId } from '@shared/lib/config/settings'

/** A surface's stored override row; null, undefined, and '' all mean "unset". */
export type RuntimeSurface = {
  llmProviderId?: string | null
  model?: string | null
  effort?: string | null
  speed?: string | null
}

export type InheritedRuntimeSelection = {
  /** What the host will send: surface override → agent default → app default. */
  model: string
  llmProviderId?: string | null
  effort?: EffortLevel
  speed?: SpeedLevel
  /** `effort`/`speed` snapped to what the catalog model allows — display only, never written back. */
  displayEffort?: EffortLevel
  displaySpeed?: SpeedLevel
  catalogModel: ModelDefinition | undefined
}

/**
 * The renderer half of the runtime-inherit contract: an override surface
 * (chat integration, cron task, webhook trigger) must show exactly what the
 * host will send for it — the same resolveRuntimeInherit ladder the four
 * session-start paths use — with illegal values snapped for display only, so
 * merely opening a card can never persist a clamp.
 *
 * Cards must derive their picker values from this hook rather than reading
 * settings/preferences themselves; a surface that invents its own fallback
 * chain reintroduces the display-vs-sent drift this exists to prevent.
 */
export function useInheritedRuntimeSelection(agentSlug: string, surface: RuntimeSurface): {
  /** False until the app-default model settings have loaded; render a placeholder. */
  ready: boolean
  /** Ladder result for `surface`, or null while not ready. */
  selection: InheritedRuntimeSelection | null
  /** Re-run the ladder for another surface (e.g. the cleared row on Reset); null while not ready. */
  resolveDisplay: (surface: RuntimeSurface) => InheritedRuntimeSelection | null
} {
  const { data: settings } = useModelSettings(agentSlug, surface.llmProviderId)
  const { data: prefs } = useAgentPreferences(agentSlug)

  const models = settings?.models
  const inheritModels = useMemo(
    () => models?.agentModel && models.agentEffort
      ? { agentModel: models.agentModel, agentEffort: models.agentEffort }
      : null,
    [models?.agentModel, models?.agentEffort],
  )

  const activeProvider = (settings?.llmProvider ?? 'anthropic') as LlmProviderId
  const catalog = useMemo(
    () => settings?.llmProviderStatus?.find((p) => p.id === activeProvider)?.catalog ?? [],
    [settings, activeProvider],
  )

  const resolveDisplay = useCallback(
    (s: RuntimeSurface): InheritedRuntimeSelection | null => {
      if (!inheritModels) return null
      const resolved = resolveRuntimeInherit(
        { model: s.model || null, effort: s.effort || null, speed: s.speed || null },
        prefs ?? {},
        inheritModels,
      )
      if (settings?.connections) {
        const pair = (model?: string | null, id?: string | null) => model && id !== null
          ? { model, llmProviderId: id ?? settings.legacyLlmProviderId ?? '' } : null
        const selection = resolveSelection(pair(s.model, s.llmProviderId), settings.connections)
          ?? resolveSelection(pair(prefs?.defaultModel, prefs?.defaultLlmProviderId), settings.connections)
          ?? resolveSelection(settings.defaultSelection, settings.connections)
        if (selection) { resolved.model = selection.model; resolved.llmProviderId = selection.llmProviderId }
      }
      const activeCatalog = settings?.connections?.find(c => c.id === resolved.llmProviderId)?.catalog ?? catalog
      const catalogModel = findCatalogModel(resolved.model, activeCatalog)
      return {
        ...resolved,
        displayEffort: clampEffortForDisplay(resolved.effort, catalogModel?.supportedEfforts),
        displaySpeed: clampSpeedForDisplay(resolved.speed, catalogModel),
        catalogModel,
      }
    },
    [inheritModels, prefs, catalog, settings],
  )

  const selection = useMemo(
    () => resolveDisplay({ llmProviderId: surface.llmProviderId, model: surface.model, effort: surface.effort, speed: surface.speed }),
    [resolveDisplay, surface.llmProviderId, surface.model, surface.effort, surface.speed],
  )

  return { ready: inheritModels !== null, selection, resolveDisplay }
}
