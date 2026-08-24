import { memo, useContext, useMemo } from 'react'
import { ChevronDown, RotateCcw, Settings } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { Separator } from '@renderer/components/ui/separator'
import { useModelSettings } from '@renderer/hooks/use-settings'
import { DialogContext } from '@renderer/context/dialog-context'
import { useUser } from '@renderer/context/user-context'
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
  /**
   * Render a footer inside the picker (per-agent default surfaces) with a
   * "Reset to Global Default" action — disabled while the host already follows
   * the app-wide default — and an admin link to Settings → LLM Provider.
   */
  appDefault?: {
    /** True when the host stores its own override (enables the reset action). */
    isOverride: boolean
    /** Clear the override so the host follows the app-wide default again. */
    onUseAppDefault: () => void
  }
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
  appDefault,
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
        {appDefault && (
          <>
            <Separator className="my-2 bg-border/50" />
            <AppDefaultFooter {...appDefault} />
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}

/**
 * Footer for per-agent default surfaces. Split out of the picker body so the
 * `useUser()` / DialogContext reads only mount for the one host that opts in —
 * the picker's other hosts stay free of a UserProvider requirement.
 */
function AppDefaultFooter({ isOverride, onUseAppDefault }: NonNullable<SettingsModelSelectProps['appDefault']>) {
  const { isAuthMode, isAdmin } = useUser()
  // Nullable by design: router-free hosts mount no DialogProvider — the
  // footer just drops its settings link there.
  const dialogs = useContext(DialogContext)
  // The LLM Provider tab is admin-gated — members get no link they can't use.
  const canChangeAppDefault = dialogs !== null && (!isAuthMode || isAdmin)

  return (
    <div className="flex items-center justify-between gap-2">
      {/* Disabled = the host already follows the app-wide default. */}
      <button
        type="button"
        data-testid="settings-model-app-default"
        disabled={!isOverride}
        onClick={() => onUseAppDefault()}
        className="flex min-w-0 items-center gap-1.5 rounded-sm px-2 py-1 text-left text-xs text-muted-foreground enabled:hover:bg-accent enabled:hover:text-foreground disabled:opacity-50"
      >
        <RotateCcw className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate">Reset to Global Default</span>
      </button>
      {canChangeAppDefault && (
        <button
          type="button"
          data-testid="settings-model-app-default-change"
          aria-label="Change global default in Settings"
          title="Change global default in Settings"
          onClick={() => dialogs?.openSettings('llm')}
          className="shrink-0 rounded-sm p-1 text-muted-foreground/70 hover:text-foreground"
        >
          <Settings className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      )}
    </div>
  )
}

export const SettingsModelSelect = memo(SettingsModelSelectImpl)
