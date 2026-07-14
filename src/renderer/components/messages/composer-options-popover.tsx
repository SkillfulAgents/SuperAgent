import { memo, useEffect, useState } from 'react'
import { ChevronDown, HelpCircle } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { Separator } from '@renderer/components/ui/separator'
import { ModelIcon } from '@renderer/components/ui/model-icon'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip'
import { cn } from '@shared/lib/utils'
import { EFFORT_LEVELS } from '@shared/lib/container/types'
import type { ModelDefinition } from '@shared/lib/llm-provider'
import { type ComposerOptionsState } from './composer-options'
import { ModelFamilyList, findCatalogModel } from './model-family-list'
import { EFFORT_LABELS, EffortSection, useEffortClamp } from './effort-slider'

// ---- Processing speed (UI exploration; local-only, not yet a runtime option) ----
type ProcessingSpeed = 'slow' | 'normal' | 'fast'

const SPEED_LABELS: Record<ProcessingSpeed, string> = {
  slow: 'Slow',
  normal: 'Normal',
  fast: 'Fast',
}

/**
 * Which speeds a model exposes depends on its vendor: Anthropic models offer
 * Normal/Fast, while every other vendor (OpenAI, xAI, Z.AI, …) adds the more
 * deliberate 'slow' tier. Normal is the universal default, so it's always a
 * safe reset target when a model switch drops the current pick. An undefined
 * model resolves as Anthropic — the composer's default vendor.
 */
function availableSpeeds(model: ModelDefinition | undefined): ProcessingSpeed[] {
  const isAnthropic = !model || model.icon === 'anthropic'
  return isAnthropic ? ['normal', 'fast'] : ['slow', 'normal', 'fast']
}

/**
 * Speed block mirroring EffortSection's header pattern ("Speed · Normal", value
 * in the accent blue, help tooltip on the right) over a segmented control in
 * the same visual language as the vendor tab bar above (muted pill, active
 * segment lifted with bg + shadow). A segment reads as a toggle, so picks never
 * dismiss the popover — consistent with model/effort picks here.
 */
function SpeedSection({
  speeds,
  value,
  onChange,
}: {
  speeds: ProcessingSpeed[]
  value: ProcessingSpeed
  onChange: (speed: ProcessingSpeed) => void
}) {
  return (
    <div>
      <div className="flex items-center justify-between px-2 pt-1 pb-1 text-[11px] font-medium text-muted-foreground/70">
        <span>
          <span>Speed</span>
          <span className="text-[#007DED] dark:text-[#4EB3FF]"> · {SPEED_LABELS[value]}</span>
        </span>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="About speed"
                data-testid="speed-help"
                className="inline-flex shrink-0 hover:text-foreground"
              >
                <HelpCircle className="h-3 w-3" aria-hidden="true" />
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-60">
              Faster processing returns replies sooner. Slower processing gives the model more
              room to work. Available speeds depend on the model.
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
      <div className="px-2 pb-1">
        <div
          role="radiogroup"
          aria-label="Processing speed"
          className="flex rounded-lg bg-muted p-0.5 text-muted-foreground"
        >
          {speeds.map((level) => {
            const isActive = level === value
            return (
              <button
                key={level}
                type="button"
                role="radio"
                aria-checked={isActive}
                data-testid={`speed-option-${level}`}
                onClick={() => onChange(level)}
                className={cn(
                  'flex-1 rounded-md px-2 py-1 text-xs transition-all hover:bg-background/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  isActive && 'bg-background text-foreground shadow'
                )}
              >
                {SPEED_LABELS[level]}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

interface ComposerOptionsPopoverProps {
  state: ComposerOptionsState
  disabled?: boolean
  /** Show the Effort section. Disable for model-only pickers (e.g. summarizer). */
  includeEffort?: boolean
}

function ComposerOptionsPopoverImpl({ state, disabled, includeEffort = true }: ComposerOptionsPopoverProps) {
  const { effort, setEffort, model, setModel, catalog, webProvider } = state

  // Trigger display fallback for the brief window before useComposerOptions
  // seeds `model`. Order: resolve the selection against the catalog (exact id
  // or family-latest) → the catalog's latest Sonnet (codebase-wide default,
  // beats falling through to the first entry) → first entry.
  const selectedModel =
    findCatalogModel(model, catalog)
    ?? catalog.find((m) => m.family === 'sonnet' && m.isLatest)
    ?? catalog[0]

  useEffortClamp(includeEffort ? selectedModel : undefined, effort, setEffort)

  const visibleEfforts = EFFORT_LEVELS.filter((level) =>
    selectedModel ? selectedModel.supportedEfforts.includes(level) : true
  )

  // Speed is local-only (UI exploration): options are gated by the selected
  // model's vendor, and a model switch that drops the current pick snaps back
  // to Normal — same clamp shape as useEffortClamp.
  const [speed, setSpeed] = useState<ProcessingSpeed>('normal')
  const visibleSpeeds = availableSpeeds(selectedModel)
  useEffect(() => {
    if (!availableSpeeds(selectedModel).includes(speed)) setSpeed('normal')
  }, [selectedModel, speed])

  const effortLabel = EFFORT_LABELS[effort]
  // Keep the trigger uncluttered: surface speed only when it's off the default.
  const speedSuffix = speed === 'normal' ? '' : ` · ${SPEED_LABELS[speed]}`
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
          className="h-[34px] gap-1.5 px-2 text-xs font-medium"
          aria-label={`${includeEffort ? 'Model and effort' : 'Model'}: ${triggerAriaLabel}. Click to change.`}
          data-testid="composer-options-trigger"
        >
          {selectedModel && <ModelIcon icon={selectedModel.icon} className="h-3.5 w-3.5 shrink-0" />}
          <span>
            {selectedModelLabel}
            {includeEffort && (
              <span className="text-muted-foreground">
                {selectedModelLabel ? ' · ' : ''}{effortLabel}{speedSuffix}
              </span>
            )}
          </span>
          <ChevronDown className="h-3.5 w-3.5" />
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
                The "Models" label renders inside, below the vendor tabs.
                Picks never dismiss: model and effort get tuned together, and the
                popover closes only on outside click / Escape / trigger toggle. */}
            <ModelFamilyList
              header="Models"
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
            show neither. Rendered last so it sits below Effort in the fixed
            Model → Effort → Speed order. */}
        {includeEffort && (
          <>
            <Separator className="my-2 bg-border/50" />
            <SpeedSection speeds={visibleSpeeds} value={speed} onChange={setSpeed} />
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}

export const ComposerOptionsPopover = memo(ComposerOptionsPopoverImpl)
