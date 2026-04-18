import { useState } from 'react'
import { Gauge } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { cn } from '@shared/lib/utils'
import { EFFORT_LEVELS, type EffortLevel } from '@shared/lib/container/types'

const OPTION_META: Record<EffortLevel, { label: string; blurb: string }> = {
  low: { label: 'Low', blurb: 'Fastest. Minimal thinking, terse answers.' },
  medium: { label: 'Medium', blurb: 'Balanced thinking and response depth.' },
  high: { label: 'High', blurb: 'Default. Thorough planning and explanations.' },
  xhigh: { label: 'Extra high', blurb: 'Opus 4.7 only. Deep reasoning for long-horizon work.' },
  max: { label: 'Max', blurb: 'Highest effort. Opus 4.6 and 4.7 only.' },
}

const OPTIONS = EFFORT_LEVELS.map((value) => ({ value, ...OPTION_META[value] }))

const SHORT_LABEL: Record<EffortLevel, string> = {
  low: 'Low',
  medium: 'Med',
  high: 'High',
  xhigh: 'X-High',
  max: 'Max',
}

interface EffortSelectorProps {
  value: EffortLevel
  onChange: (value: EffortLevel) => void
  disabled?: boolean
}

export function EffortSelector({ value, onChange, disabled }: EffortSelectorProps) {
  const [open, setOpen] = useState(false)
  const shortLabel = SHORT_LABEL[value] ?? 'High'

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          className="h-[34px] gap-1.5 px-2 text-xs font-medium text-muted-foreground hover:text-foreground"
          aria-label={`Effort: ${shortLabel}. Click to change.`}
          data-testid="effort-selector-trigger"
        >
          <Gauge className="h-3.5 w-3.5" />
          <span>{shortLabel}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-52 p-1" align="start">
        <div className="flex flex-col">
          {OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              data-testid={`effort-option-${option.value}`}
              onClick={() => {
                onChange(option.value)
                setOpen(false)
              }}
              className={cn(
                'flex flex-col items-start rounded-sm px-2 py-1 text-left hover:bg-accent',
                value === option.value && 'bg-accent'
              )}
            >
              <span className="text-xs font-medium leading-tight">{option.label}</span>
              <span className="text-xs leading-tight text-muted-foreground">{option.blurb}</span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
