import { useCallback, useEffect, useMemo, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { useSettings } from '@renderer/hooks/use-settings'
import { ComposerOptionsPopover } from '@renderer/components/messages/composer-options-popover'
import { DetailCard } from './detail-card'
import type { ComposerOptionsState } from '@renderer/components/messages/composer-options'
import type { EffortLevel } from '@shared/lib/container/types'
import type { ComposerModel } from '@shared/lib/llm-provider'
import type { LlmProviderId } from '@shared/lib/config/settings'

interface RuntimeOptionsCardProps {
  model: string | null
  effort: string | null
  disabled?: boolean
  onUpdate: (options: { model?: string | null; effort?: string | null }) => void
}

export function RuntimeOptionsCard({ model, effort, disabled, onUpdate }: RuntimeOptionsCardProps) {
  const { data: settings } = useSettings()
  const activeProvider = (settings?.llmProvider ?? 'anthropic') as LlmProviderId
  const composerModels = useMemo(
    () => settings?.llmProviderStatus?.find(p => p.id === activeProvider)?.composerModels ?? [],
    [settings, activeProvider],
  )

  const fallbackModel = useMemo(() => (
    settings?.models?.agentModel
    ?? composerModels.find(m => m.family === 'sonnet')?.modelId
    ?? composerModels[0]?.modelId
  ), [settings, composerModels])

  const [localEffort, setLocalEffort] = useState<EffortLevel>((effort as EffortLevel) || 'high')
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
    if (model) {
      setLocalModel(model)
    }
  }, [model])

  const handleSetEffort = useCallback((e: EffortLevel) => {
    setLocalEffort(e)
    onUpdate({ effort: e })
  }, [onUpdate])

  const handleSetModel = useCallback((m: string) => {
    setLocalModel(m)
    onUpdate({ model: m })
  }, [onUpdate])

  const handleReset = useCallback(() => {
    setLocalEffort('high')
    setLocalModel(fallbackModel)
    onUpdate({ model: null, effort: null })
  }, [onUpdate, fallbackModel])

  const toRuntimeOptions = useCallback(
    () => ({ effort: localEffort, ...(localModel ? { model: localModel } : {}) }),
    [localEffort, localModel],
  )

  const state: ComposerOptionsState = useMemo(
    () => ({
      effort: localEffort,
      setEffort: handleSetEffort,
      model: localModel,
      setModel: handleSetModel,
      composerModels: composerModels as ComposerModel[],
      toRuntimeOptions,
    }),
    [localEffort, handleSetEffort, localModel, handleSetModel, composerModels, toRuntimeOptions],
  )

  const hasCustom = model !== null || effort !== null

  return (
    <DetailCard
      label="Model & Effort"
      headerActions={hasCustom && !disabled ? (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 text-xs text-muted-foreground"
          onClick={handleReset}
        >
          <RotateCcw className="h-3 w-3" />
          Reset
        </Button>
      ) : undefined}
    >
      <div className="flex items-center gap-2">
        <ComposerOptionsPopover state={state} disabled={disabled} />
        {!hasCustom && (
          <span className="text-xs text-muted-foreground">Using defaults</span>
        )}
      </div>
    </DetailCard>
  )
}
