import { useCallback, useEffect, useMemo, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { useSettings } from '@renderer/hooks/use-settings'
import { SettingsModelSelect } from '@renderer/components/settings/settings-model-select'
import { DetailCard } from './detail-card'
import type { EffortLevel, SpeedLevel } from '@shared/lib/container/types'

interface RuntimeOptionsCardProps {
  model: string | null
  effort: string | null
  speed: string | null
  disabled?: boolean
  onUpdate: (options: { model?: string | null; effort?: string | null; speed?: string | null }) => void
}

export function RuntimeOptionsCard({ model, effort, speed, disabled, onUpdate }: RuntimeOptionsCardProps) {
  const { data: settings } = useSettings()
  // The override falls back to the user's default-model setting (a bare alias
  // or pinned id) when no per-run model is set. The picker resolves it for display.
  const fallbackModel = settings?.models?.agentModel

  const [localEffort, setLocalEffort] = useState<EffortLevel>((effort as EffortLevel) || 'high')
  const [localSpeed, setLocalSpeed] = useState<SpeedLevel>((speed as SpeedLevel) || 'normal')
  const [localModel, setLocalModel] = useState<string | undefined>(model || fallbackModel)

  useEffect(() => {
    if (fallbackModel && !model) {
      setLocalModel(fallbackModel)
    }
  }, [fallbackModel, model])

  useEffect(() => {
    setLocalEffort((effort as EffortLevel) || 'high')
  }, [effort])

  useEffect(() => {
    setLocalSpeed((speed as SpeedLevel) || 'normal')
  }, [speed])

  useEffect(() => {
    if (model) {
      setLocalModel(model)
    }
  }, [model])

  const handleSetEffort = useCallback((e: EffortLevel) => {
    setLocalEffort(e)
    onUpdate({ effort: e })
  }, [onUpdate])

  const handleSetSpeed = useCallback((s: SpeedLevel) => {
    setLocalSpeed(s)
    onUpdate({ speed: s })
  }, [onUpdate])

  const handleSetModel = useCallback((m: string) => {
    setLocalModel(m)
    onUpdate({ model: m })
  }, [onUpdate])

  const handleReset = useCallback(() => {
    setLocalEffort('high')
    setLocalSpeed('normal')
    setLocalModel(fallbackModel)
    onUpdate({ model: null, effort: null, speed: null })
  }, [onUpdate, fallbackModel])

  const hasCustom = model !== null || effort !== null || speed !== null

  const headerActions = useMemo(
    () =>
      hasCustom && !disabled ? (
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
    [hasCustom, disabled, handleReset],
  )

  return (
    <DetailCard label="Model & Effort" headerActions={headerActions}>
      <div className="flex items-center gap-2">
        <SettingsModelSelect
          model={localModel}
          onModelChange={handleSetModel}
          includeEffort
          effort={localEffort}
          onEffortChange={handleSetEffort}
          includeSpeed
          speed={localSpeed}
          onSpeedChange={handleSetSpeed}
          disabled={disabled}
          // This trigger is left-aligned in its card, so its LEFT edge is the
          // stable anchor while picks rewrite the label width.
          align="start"
        />
        {!hasCustom && <span className="text-xs text-muted-foreground">Using defaults</span>}
      </div>
    </DetailCard>
  )
}
