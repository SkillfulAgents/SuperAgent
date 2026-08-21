import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { SettingsModelSelect } from '@renderer/components/settings/settings-model-select'
import { useInheritedRuntimeSelection } from '@renderer/hooks/use-inherited-runtime-selection'
import { DetailCard } from './detail-card'
import type { EffortLevel, SpeedLevel } from '@shared/lib/container/types'

interface RuntimeOptionsCardProps {
  agentSlug: string
  model: string | null
  effort: string | null
  speed: string | null
  disabled?: boolean
  onUpdate: (options: { model?: string | null; effort?: string | null; speed?: string | null }) => void
}

export function RuntimeOptionsCard({ agentSlug, model, effort, speed, disabled, onUpdate }: RuntimeOptionsCardProps) {
  const picked = useRef(false)
  const { ready, selection, resolveDisplay } = useInheritedRuntimeSelection(agentSlug, { model, effort, speed })

  // Local mirror so a pick shows immediately; the parent's save round-trips
  // through props, and the sync effect below re-adopts the inherit once it
  // lands (or whenever the stored row changes underneath an untouched card).
  const [localEffort, setLocalEffort] = useState<EffortLevel | undefined>(selection?.displayEffort)
  const [localSpeed, setLocalSpeed] = useState<SpeedLevel | undefined>(selection?.displaySpeed)
  const [localModel, setLocalModel] = useState<string | undefined>(selection?.model)

  useEffect(() => {
    picked.current = false
  }, [model, effort, speed])

  useEffect(() => {
    if (!selection || picked.current) return
    setLocalEffort(selection.displayEffort)
    setLocalSpeed(selection.displaySpeed)
    setLocalModel(selection.model)
  }, [selection])

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
    const cleared = resolveDisplay({ model: null, effort: null, speed: null })
    if (!cleared) return
    picked.current = false
    setLocalEffort(cleared.displayEffort)
    setLocalSpeed(cleared.displaySpeed)
    setLocalModel(cleared.model)
    onUpdate({ model: null, effort: null, speed: null })
  }, [onUpdate, resolveDisplay])

  const hasCustom = model !== null || effort !== null || speed !== null
  const canReset = Boolean(hasCustom && !disabled && ready)

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
        {selection?.model && selection.effort && localEffort ? (
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
        {!hasCustom && ready && <span className="text-xs text-muted-foreground">Using defaults</span>}
      </div>
    </DetailCard>
  )
}
