import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { useAgentPreferences } from '@renderer/hooks/use-agent-preferences'
import { useModelSettings } from '@renderer/hooks/use-settings'
import { SettingsModelSelect } from '@renderer/components/settings/settings-model-select'
import { findCatalogModel } from '@renderer/components/messages/model-family-list'
import {
  clampEffortForDisplay,
  clampSpeedForDisplay,
  resolveRuntimeInherit,
} from '@shared/lib/container/runtime-options'
import { DetailCard } from './detail-card'
import type { EffortLevel, SpeedLevel } from '@shared/lib/container/types'
import type { LlmProviderId } from '@shared/lib/config/settings'

interface RuntimeOptionsCardProps {
  agentSlug: string
  model: string | null
  effort: string | null
  speed: string | null
  disabled?: boolean
  onUpdate: (options: { model?: string | null; effort?: string | null; speed?: string | null }) => void
}

export function RuntimeOptionsCard({ agentSlug, model, effort, speed, disabled, onUpdate }: RuntimeOptionsCardProps) {
  const { data: settings } = useModelSettings()
  const { data: prefs } = useAgentPreferences(agentSlug)
  const picked = useRef(false)

  const models = settings?.models
  const inheritModels = useMemo(
    () => models?.agentModel && models.agentEffort
      ? { agentModel: models.agentModel, agentEffort: models.agentEffort }
      : null,
    [models?.agentModel, models?.agentEffort],
  )
  const resolved = useMemo(
    () => inheritModels
      ? resolveRuntimeInherit(
          { model: model || null, effort: effort || null, speed: speed || null },
          prefs ?? {},
          inheritModels,
        )
      : null,
    [inheritModels, model, effort, speed, prefs],
  )

  const activeProvider = (settings?.llmProvider ?? 'anthropic') as LlmProviderId
  const catalog = settings?.llmProviderStatus?.find((p) => p.id === activeProvider)?.catalog ?? []
  const catalogModel = findCatalogModel(resolved?.model, catalog)
  const displayEffort = clampEffortForDisplay(resolved?.effort, catalogModel?.supportedEfforts)
  const displaySpeed = clampSpeedForDisplay(resolved?.speed, catalogModel?.supportedSpeeds as SpeedLevel[] | undefined)

  const [localEffort, setLocalEffort] = useState<EffortLevel | undefined>(displayEffort)
  const [localSpeed, setLocalSpeed] = useState<SpeedLevel | undefined>(displaySpeed)
  const [localModel, setLocalModel] = useState<string | undefined>(resolved?.model)

  useEffect(() => {
    picked.current = false
  }, [model, effort, speed])

  useEffect(() => {
    if (!resolved || picked.current) return
    setLocalEffort(displayEffort)
    setLocalSpeed(displaySpeed)
    setLocalModel(resolved.model)
  }, [resolved, displayEffort, displaySpeed])

  const handleSetEffort = useCallback((e: EffortLevel) => {
    picked.current = true
    setLocalEffort(e)
    onUpdate({ effort: e })
  }, [onUpdate])

  const handleSetSpeed = useCallback((s: SpeedLevel) => {
    picked.current = true
    setLocalSpeed(s)
    onUpdate({ speed: s })
  }, [onUpdate])

  const handleSetModel = useCallback((m: string) => {
    picked.current = true
    setLocalModel(m)
    onUpdate({ model: m })
  }, [onUpdate])

  const handleReset = useCallback(() => {
    if (!inheritModels) return
    picked.current = false
    const cleared = resolveRuntimeInherit({ model: null, effort: null, speed: null }, prefs ?? {}, inheritModels)
    const clearedModel = findCatalogModel(cleared.model, catalog)
    setLocalEffort(clampEffortForDisplay(cleared.effort, clearedModel?.supportedEfforts))
    setLocalSpeed(clampSpeedForDisplay(cleared.speed, clearedModel?.supportedSpeeds as SpeedLevel[] | undefined))
    setLocalModel(cleared.model)
    onUpdate({ model: null, effort: null, speed: null })
  }, [onUpdate, inheritModels, prefs, catalog])

  const hasCustom = model !== null || effort !== null || speed !== null
  const canReset = Boolean(hasCustom && !disabled && inheritModels)

  const headerActions = useMemo(
    () =>
      canReset ? (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 text-xs text-muted-foreground"
          onClick={handleReset}
        >
          <RotateCcw className="h-3 w-3" />
          Reset
        </Button>
      ) : undefined,
    [canReset, handleReset],
  )

  return (
    <DetailCard label="Model & Effort" headerActions={headerActions}>
      <div className="flex items-center gap-2">
        {resolved?.model && resolved.effort && localEffort ? (
          <SettingsModelSelect
            model={localModel}
            onModelChange={handleSetModel}
            includeEffort
            effort={localEffort}
            onEffortChange={handleSetEffort}
            includeSpeed
            speed={localSpeed ?? 'normal'}
            onSpeedChange={handleSetSpeed}
            disabled={disabled}
            // This trigger is left-aligned in its card, so its LEFT edge is the
            // stable anchor while picks rewrite the label width.
            align="start"
          />
        ) : (
          <span className="text-xs text-muted-foreground" data-testid="runtime-inherit-pending">—</span>
        )}
        {!hasCustom && inheritModels && <span className="text-xs text-muted-foreground">Using defaults</span>}
      </div>
    </DetailCard>
  )
}
