import { memo, type ReactNode } from 'react'
import { ChevronDown, Settings2 } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { Separator } from '@renderer/components/ui/separator'
import { EFFORT_LEVELS } from '@shared/lib/container/types'
import { type ComposerOptionsState } from './composer-options'
import { ModelFamilyList, findCatalogModel } from './model-family-list'
import { EFFORT_LABELS, EffortSection, useEffortClamp } from './effort-slider'
import { SPEED_LABELS, SpeedSection, availableSpeeds, useSpeedClamp } from './speed-section'

interface ComposerOptionsPopoverProps {
  state: ComposerOptionsState
  disabled?: boolean
  /** Show the Effort section. Disable for model-only pickers (e.g. summarizer). */
  includeEffort?: boolean
  /** Optional caller-owned content rendered after the picker sections. */
  footer?: ReactNode
}

function ComposerOptionsPopoverImpl({ state, disabled, includeEffort = true, footer }: ComposerOptionsPopoverProps) {
  const { effort, setEffort, speed, setSpeed, model, setModel, catalog, defaultModel, webProvider } = state

  // Trigger display fallback for the brief window before useComposerOptions
  // seeds `model`. Order: resolve the selection against the catalog (exact id
  // or family-latest) → the active provider's catalog default → first entry.
  const selectedModel =
    findCatalogModel(model, catalog)
    ?? findCatalogModel(defaultModel, catalog)
    ?? catalog[0]

  useEffortClamp(includeEffort ? selectedModel : undefined, effort, setEffort)

  const visibleEfforts = EFFORT_LEVELS.filter((level) =>
    selectedModel ? selectedModel.supportedEfforts.includes(level) : true
  )

  // Speed options come from the selected model's catalog entry; a model switch
  // that drops the current pick snaps back to Normal.
  const visibleSpeeds = availableSpeeds(selectedModel)
  useSpeedClamp(includeEffort ? selectedModel : undefined, speed, setSpeed)

  const effortLabel = EFFORT_LABELS[effort]
  // Keep the trigger uncluttered: surface speed only when it's off the default.
  // Session metadata deliberately persists speed as an open string (forward
  // compat), so an off-enum value can reach here — render no suffix rather
  // than "· undefined".
  const speedLabel: string | undefined = SPEED_LABELS[speed]
  const speedSuffix = speed !== 'normal' && speedLabel ? ` · ${speedLabel}` : ''
  const selectedModelLabel = selectedModel?.label
  const triggerAriaLabel = includeEffort
    ? (selectedModelLabel ? `${selectedModelLabel} · ${effortLabel}${speedSuffix}` : `${effortLabel}${speedSuffix}`)
    : (selectedModelLabel ?? 'Model')

  return (
    // Uncontrolled: nothing closes the popover programmatically anymore (picks
    // never dismiss), so Radix owns the open state.
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          className="h-[34px] min-w-0 gap-1.5 px-2 text-xs font-medium max-[420px]:w-[34px] max-[420px]:shrink-0 max-[420px]:justify-center max-[420px]:px-0"
          aria-label={`${includeEffort ? 'Model and effort' : 'Model'}: ${triggerAriaLabel}. Click to change.`}
          data-testid="composer-options-trigger"
        >
          <Settings2 className="hidden h-3.5 w-3.5 max-[420px]:block" aria-hidden="true" />
          <span className="max-[420px]:hidden">
            {selectedModelLabel}
            {includeEffort && (
              <span className="text-muted-foreground">
                {selectedModelLabel ? ' · ' : ''}{effortLabel}{speedSuffix}
              </span>
            )}
          </span>
          <ChevronDown className="h-3.5 w-3.5 max-[420px]:hidden" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        // Fixed reading order Model → Effort → Speed in both open directions —
        // no col-reverse (unlike the settings picker, which flips to keep Effort
        // by the trigger). Speed is the tertiary knob, so it stays at the bottom.
        className="flex w-64 flex-col px-1 py-2"
        align="start"
        // Don't auto-focus the first element (a vendor tab) on open — focusing
        // it pops its name tooltip instantly. Keyboard users can Tab in.
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        {selectedModel && (
          <>
            {/* Flat list, no "latest" — per-message picks a concrete version.
                Picks never dismiss: model and effort get tuned together, and the
                popover closes only on outside click / Escape / trigger toggle. */}
            <ModelFamilyList
              catalog={catalog}
              value={model}
              onPick={setModel}
              webProvider={webProvider}
            />
            {includeEffort && <Separator className="my-2 bg-border/50" />}
          </>
        )}
        {includeEffort && (
          <EffortSection levels={visibleEfforts} value={effort} onChange={setEffort} />
        )}
        {/* Speed rides the same gate as Effort: model-only pickers (summarizer)
            show neither. Hidden entirely for models whose serving path offers
            no speed choice (normal-only). Rendered last so it sits below
            Effort in the fixed Model → Effort → Speed order. */}
        {includeEffort && visibleSpeeds.length > 1 && (
          <>
            <Separator className="my-2 bg-border/50" />
            <SpeedSection speeds={visibleSpeeds} value={speed} onChange={setSpeed} />
          </>
        )}
        {footer}
      </PopoverContent>
    </Popover>
  )
}

export const ComposerOptionsPopover = memo(ComposerOptionsPopoverImpl)
