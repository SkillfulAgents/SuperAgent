import { memo, useEffect, useMemo, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { Separator } from '@renderer/components/ui/separator'
import { ModelIcon } from '@renderer/components/ui/model-icon'
import { useSettings } from '@renderer/hooks/use-settings'
import { ModelFamilyList, findCatalogModel, familyDisplayName } from '@renderer/components/messages/model-family-list'
import { EFFORT_LABELS, EffortSection } from '@renderer/components/messages/effort-slider'
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

/**
 * The two-layered model picker used by saved-setting selectors (default model,
 * summarizer, browser, scheduled-job/trigger, chat integration).
 *
 * The flat model list is the shared {@link ModelFamilyList}, here with
 * `offerLatest` on: each family shows a **Latest** row (stores the bare alias,
 * rides upgrades) plus its **specific versions** (store the concrete id, pinned),
 * labeled `· latest` / `· pinned`. Reads and writes the raw selection string —
 * resolution happens host-side.
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

  // Picks never dismiss (matching the composer): model and effort get set in
  // one visit; the popover closes on outside click / Escape / trigger toggle.
  const pick = (value: string) => {
    onModelChange(value)
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
                {' · '}{EFFORT_LABELS[effort]}
              </span>
            )}
          </span>
          <ChevronDown className="h-3.5 w-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-64 px-1 py-2"
        align="start"
        // Don't auto-focus the first element (a vendor tab) on open — focusing
        // it pops its name tooltip instantly. Keyboard users can Tab in.
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <ModelFamilyList
          header="Model"
          catalog={catalog}
          value={model}
          onPick={pick}
          offerLatest
          webProvider={settings?.webProvider}
        />
        {includeEffort && (
          <>
            <Separator className="my-2 bg-border/50" />
            <EffortSection
              levels={visibleEfforts}
              value={effort}
              onChange={(level) => onEffortChange?.(level)}
            />
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}

export const SettingsModelSelect = memo(SettingsModelSelectImpl)
