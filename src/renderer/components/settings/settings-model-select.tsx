import { memo, useEffect, useMemo, useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { Separator } from '@renderer/components/ui/separator'
import { ModelIcon } from '@renderer/components/ui/model-icon'
import { useSettings } from '@renderer/hooks/use-settings'
import { ModelFamilyList, findCatalogModel, familyDisplayName } from '@renderer/components/messages/model-family-list'
import { cn } from '@shared/lib/utils'
import { EFFORT_LEVELS, type EffortLevel } from '@shared/lib/container/types'
import type { LlmProviderId } from '@shared/lib/config/settings'

interface SettingsModelSelectProps {
  /** Currently-selected model — a concrete id (pinned) or a bare family alias (latest); undefined while loading. */
  model: string | undefined
  onModelChange: (model: string) => void
  /** Show the effort picker alongside the model. Off by default for model-only knobs. */
  includeEffort?: boolean
  effort?: EffortLevel
  onEffortChange?: (effort: EffortLevel) => void
  disabled?: boolean
}

const EFFORT_LABEL: Record<EffortLevel, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max',
}

function EffortRow({ label, isSelected, onClick, testId }: {
  label: string
  isSelected: boolean
  onClick: () => void
  testId: string
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className={cn(
        'flex items-center justify-between gap-2 rounded-sm px-2 py-1 text-left text-xs hover:bg-accent',
        isSelected && 'bg-accent'
      )}
    >
      <span className="truncate">{label}</span>
      {isSelected && <Check className="h-3.5 w-3.5 shrink-0 text-foreground" />}
    </button>
  )
}

/**
 * The two-layered model picker used by saved-setting selectors (default model,
 * summarizer, browser, scheduled-job/trigger, chat integration).
 *
 * The grouped family/version list is the shared {@link ModelFamilyList}, here
 * with `offerLatest` on: each family expands to **Latest** (stores the bare
 * alias, rides upgrades) plus **specific versions** (store the concrete id,
 * pinned), labeled `· latest` / `· pinned`. Reads and writes the raw selection
 * string — resolution happens host-side.
 */
function SettingsModelSelectImpl({
  model,
  onModelChange,
  includeEffort = false,
  effort = 'medium',
  onEffortChange,
  disabled,
}: SettingsModelSelectProps) {
  const { data: settings } = useSettings()
  const [open, setOpen] = useState(false)
  const activeProvider = (settings?.llmProvider ?? 'anthropic') as LlmProviderId
  const catalog = useMemo(
    () => settings?.llmProviderStatus?.find((p) => p.id === activeProvider)?.catalog ?? [],
    [settings, activeProvider],
  )

  // Resolve the current selection for the trigger label.
  const resolved = findCatalogModel(model, catalog)
  const isLatestSelected = model !== undefined && catalog.some((m) => m.family === model)
  const selectedFamily = isLatestSelected ? model : resolved?.family

  // Reset to Medium when the resolved model can't do the current effort.
  const supportsCurrentEffort = resolved?.supportedEfforts.includes(effort) ?? true
  useEffect(() => {
    if (includeEffort && onEffortChange && resolved && !supportsCurrentEffort) {
      onEffortChange('medium')
    }
  }, [includeEffort, onEffortChange, resolved, supportsCurrentEffort])

  const visibleEfforts = EFFORT_LEVELS.filter((level) =>
    resolved ? resolved.supportedEfforts.includes(level) : true
  )

  let triggerLabel: string | undefined
  if (isLatestSelected && selectedFamily) triggerLabel = `${familyDisplayName(selectedFamily)} · latest`
  else if (resolved?.family) triggerLabel = `${resolved.label} · pinned`
  else if (resolved) triggerLabel = resolved.label

  const pick = (value: string) => {
    onModelChange(value)
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          className="h-[34px] gap-1.5 px-2 text-xs font-medium"
          aria-label={`Model: ${triggerLabel ?? 'select'}. Click to change.`}
          data-testid="settings-model-trigger"
        >
          {resolved && <ModelIcon icon={resolved.icon} className="h-3.5 w-3.5 shrink-0" />}
          <span>
            {triggerLabel ?? 'Select model'}
            {includeEffort && (
              <span className="text-muted-foreground">
                {triggerLabel ? ' · ' : ''}{EFFORT_LABEL[effort]}
              </span>
            )}
          </span>
          <ChevronDown className="h-3.5 w-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 px-1 py-2" align="start">
        <div className="px-2 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Model
        </div>
        <ModelFamilyList catalog={catalog} value={model} onPick={pick} offerLatest />
        {includeEffort && (
          <>
            <Separator className="my-2" />
            <div className="px-2 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Effort
            </div>
            <div className="flex flex-col gap-0.5">
              {visibleEfforts.map((level) => (
                <EffortRow
                  key={level}
                  label={EFFORT_LABEL[level]}
                  isSelected={effort === level}
                  onClick={() => {
                    onEffortChange?.(level)
                    setOpen(false)
                  }}
                  testId={`effort-option-${level}`}
                />
              ))}
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}

export const SettingsModelSelect = memo(SettingsModelSelectImpl)
