import { useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { cn } from '@shared/lib/utils'
import { EFFORT_LEVELS, type EffortLevel } from '@shared/lib/container/types'

const OPTION_META: Record<EffortLevel, { label: string; models?: string; blurb: string }> = {
  low: { label: 'Low', blurb: 'Fastest. Minimal thinking, terse answers.' },
  medium: { label: 'Medium', blurb: 'Balanced thinking and response depth.' },
  high: { label: 'High', blurb: 'Default. Thorough planning and explanations.' },
  xhigh: { label: 'Extra High', models: 'Opus 4.7 only', blurb: 'Deep reasoning for long-horizon work.' },
  max: { label: 'Max', models: 'Opus 4.6/4.7 only', blurb: 'Highest effort.' },
}

const OPTIONS = EFFORT_LEVELS.map((value) => ({ value, ...OPTION_META[value] }))

const SHORT_LABEL: Record<EffortLevel, string> = {
  low: 'Low',
  medium: 'Med',
  high: 'High',
  xhigh: 'Extra High',
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
          variant="outline"
          size="sm"
          disabled={disabled}
          className="h-[34px] gap-1.5 px-2 text-xs font-medium"
          aria-label={`Effort: ${shortLabel}. Click to change.`}
          data-testid="effort-selector-trigger"
        >
          <span>{shortLabel}</span>
          <ChevronDown className="h-3.5 w-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 px-1 py-2" align="start">
        <div className="flex flex-col gap-1">
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
                'group flex items-start justify-between gap-2 rounded-sm px-2 py-1 text-left hover:bg-accent',
                value === option.value && 'bg-accent'
              )}
            >
              <span className="flex flex-col">
                <span className="text-sm font-normal">
                  <span>{option.label}</span>
                  {option.models && (
                    <span className="ml-1.5 text-xs text-muted-foreground">{option.models}</span>
                  )}
                </span>
                <span
                  className={cn(
                    'overflow-hidden text-xs font-normal text-muted-foreground transition-[max-height,opacity,margin-top] duration-500 ease-out',
                    value === option.value
                      ? 'mt-0.5 max-h-16 opacity-100'
                      : 'mt-0 max-h-0 opacity-0 group-hover:mt-0.5 group-hover:max-h-16 group-hover:opacity-100'
                  )}
                >
                  {option.blurb}
                </span>
              </span>
              {value === option.value && (
                <Check className="h-3.5 w-3.5 shrink-0 self-center text-foreground" />
              )}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
