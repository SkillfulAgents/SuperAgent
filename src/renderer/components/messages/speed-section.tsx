import { useEffect } from 'react'
import { HelpCircle } from 'lucide-react'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip'
import { cn } from '@shared/lib/utils'
import type { SpeedLevel } from '@shared/lib/container/types'
import type { ModelDefinition } from '@shared/lib/llm-provider'

export const SPEED_LABELS: Record<SpeedLevel, string> = {
  slow: 'Slow',
  normal: 'Normal',
  fast: 'Fast',
}

const NORMAL_ONLY: SpeedLevel[] = ['normal']

/**
 * Speeds come from the catalog entry: `supportedSpeeds` declares what the
 * model's serving path can actually honor (see builtin-catalogs.ts). Omitted
 * means no speed choice — 'normal' only. Normal is the universal default, so
 * it's always a safe reset target when a model switch drops the current pick.
 */
export function availableSpeeds(model: ModelDefinition | undefined): SpeedLevel[] {
  return (model?.supportedSpeeds as SpeedLevel[] | undefined) ?? NORMAL_ONLY
}

/**
 * Snap speed back to 'normal' when a model switch drops the current pick —
 * same clamp shape as useEffortClamp. Pass `undefined` as the model to
 * disable (e.g. when the speed picker isn't rendered).
 */
export function useSpeedClamp(
  model: ModelDefinition | undefined,
  speed: SpeedLevel,
  onSpeedChange: ((s: SpeedLevel) => void) | undefined,
): void {
  useEffect(() => {
    if (!model || !onSpeedChange) return
    if (!availableSpeeds(model).includes(speed)) onSpeedChange('normal')
  }, [model, speed, onSpeedChange])
}

/**
 * Speed block mirroring EffortSection's header pattern ("Speed · Normal", value
 * in the accent blue, help tooltip on the right) over a segmented control in
 * the same visual language as the vendor tab bar (muted pill, active segment
 * lifted with bg + shadow). A segment reads as a toggle, so picks never
 * dismiss the popover — consistent with model/effort picks.
 */
export function SpeedSection({
  speeds,
  value,
  onChange,
}: {
  speeds: SpeedLevel[]
  value: SpeedLevel
  onChange: (speed: SpeedLevel) => void
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
              Faster processing returns replies sooner at a higher price. Slower processing costs
              less but may wait for capacity. Available speeds depend on the model.
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
