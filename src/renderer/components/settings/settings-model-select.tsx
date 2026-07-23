import { memo, useMemo } from 'react'
import { ChevronDown } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { Separator } from '@renderer/components/ui/separator'
import { ModelIcon } from '@renderer/components/ui/model-icon'
import { useModelSettings } from '@renderer/hooks/use-settings'
import { ModelFamilyList, findCatalogModel, familyDisplayName } from '@renderer/components/messages/model-family-list'
import { EFFORT_LABELS, EffortSection, useEffortClamp } from '@renderer/components/messages/effort-slider'
import { SPEED_LABELS, SpeedSection, availableSpeeds, useSpeedClamp } from '@renderer/components/messages/speed-section'
import { EFFORT_LEVELS, type EffortLevel, type SpeedLevel } from '@shared/lib/container/types'
import type { LlmProviderId } from '@shared/lib/config/settings'

interface SettingsModelSelectProps {
  /** Currently-selected model — a concrete id (pinned) or a bare family alias (latest); undefined while loading. */
  model: string | undefined
  onModelChange: (model: string) => void
  /** Show the effort picker alongside the model. Off by default for model-only knobs. */
  includeEffort?: boolean
  effort?: EffortLevel
  onEffortChange?: (effort: EffortLevel) => void
  /** Show the speed picker (only renders when the model offers a choice). Off by default. */
  includeSpeed?: boolean
  speed?: SpeedLevel
  onSpeedChange?: (speed: SpeedLevel) => void
  disabled?: boolean
  /**
   * Which trigger edge the popover anchors to. Picks rewrite the trigger label
   * live, so its width changes while the popover is open — anchor to the edge
   * the host layout keeps FIXED or the popover slides on every selection.
   * 'end' (default) for right-aligned rows (settings rows, the agent-home
   * card); 'start' for left-aligned hosts (the trigger/cron runtime card).
   */
  align?: 'start' | 'end'
}

/**
 * The flat model picker used by saved-setting selectors (default model,
 * summarizer, browser, scheduled-job/trigger, chat integration).
 *
 * The list is the shared {@link ModelFamilyList}, here with `offerLatest` on:
 * a family's **Latest** chip stores the bare alias (rides upgrades) and its
 * version chips store concrete ids (pinned); latest-vs-pinned reads from the
 * lit chip, and only the trigger label spells out `· latest` / `· pinned`.
 * Reads and writes the raw selection string — resolution happens host-side.
 */
function SettingsModelSelectImpl({
  model,
  onModelChange,
  includeEffort = false,
  effort = 'medium',
  onEffortChange,
  includeSpeed = false,
  speed = 'normal',
  onSpeedChange,
  disabled,
  align = 'end',
}: SettingsModelSelectProps) {
  // Picker-safe endpoint — this select also serves non-admin surfaces (the
  // agent-home Default Model card), where the admin-gated settings 403.
  const { data: settings } = useModelSettings()
  const activeProvider = (settings?.llmProvider ?? 'anthropic') as LlmProviderId
  const catalog = useMemo(
    () => settings?.llmProviderStatus?.find((p) => p.id === activeProvider)?.catalog ?? [],
    [settings, activeProvider],
  )

  // Resolve the current selection for the trigger label.
  const resolved = findCatalogModel(model, catalog)
  const isLatestSelected = model !== undefined && catalog.some((m) => m.family === model)
  const selectedFamily = isLatestSelected ? model : resolved?.family

  useEffortClamp(includeEffort ? resolved : undefined, effort, onEffortChange)
  useSpeedClamp(includeSpeed ? resolved : undefined, speed, onSpeedChange)

  const visibleEfforts = EFFORT_LEVELS.filter((level) =>
    resolved ? resolved.supportedEfforts.includes(level) : true
  )
  const visibleSpeeds = availableSpeeds(resolved)

  let triggerLabel: string | undefined
  if (isLatestSelected && selectedFamily) triggerLabel = `${familyDisplayName(selectedFamily)} · latest`
  else if (resolved?.family) triggerLabel = `${resolved.label} · pinned`
  else if (resolved) triggerLabel = resolved.label

  return (
    // Uncontrolled: picks never dismiss (matching the composer) — model and
    // effort get set in one visit and the popover closes on outside click /
    // Escape / trigger toggle — so Radix owns the open state.
    <Popover>
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
                {includeSpeed && speed !== 'normal' ? ` · ${SPEED_LABELS[speed]}` : ''}
              </span>
            )}
          </span>
          <ChevronDown className="h-3.5 w-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="flex w-64 flex-col px-1 py-2 data-[side=bottom]:flex-col-reverse"
        align={align}
        collisionPadding={8}
        // Don't auto-focus the first element (a vendor tab) on open — focusing
        // it pops its name tooltip instantly. Keyboard users can Tab in.
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <ModelFamilyList
          header="Model"
          catalog={catalog}
          value={model}
          onPick={onModelChange}
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
        {/* Hidden entirely for models whose serving path offers no speed choice. */}
        {includeSpeed && visibleSpeeds.length > 1 && (
          <>
            <Separator className="my-2 bg-border/50" />
            <SpeedSection
              speeds={visibleSpeeds}
              value={speed}
              onChange={(level) => onSpeedChange?.(level)}
            />
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}

export const SettingsModelSelect = memo(SettingsModelSelectImpl)
