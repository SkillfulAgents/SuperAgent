import { useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { cn } from '@shared/lib/utils'
import type { ComposerModel } from '@shared/lib/llm-provider'

const FAMILY_BLURB: Record<string, string> = {
  haiku: 'Fastest and cheapest. Good for quick or simple tasks.',
  sonnet: 'Balanced speed and capability.',
  opus: 'Most capable. Best for complex, long-horizon work.',
}

interface ModelSelectorProps {
  /** Pinned model ID currently selected (e.g. "claude-opus-4-7"). */
  value: string | undefined
  onChange: (modelId: string) => void
  /** Family options sourced from the active provider via /api/settings/global. */
  options: ComposerModel[]
  disabled?: boolean
}

export function ModelSelector({ value, onChange, options, disabled }: ModelSelectorProps) {
  const [open, setOpen] = useState(false)

  if (options.length === 0) {
    // Provider doesn't expose composer-level family selection — hide entirely.
    return null
  }

  const selected = options.find((m) => m.modelId === value) ?? options.find((m) => m.family === 'sonnet') ?? options[0]
  const shortLabel = selected.label

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          className="h-[34px] gap-1.5 px-2 text-xs font-medium"
          aria-label={`Model: ${shortLabel}. Click to change.`}
          data-testid="model-selector-trigger"
        >
          <span>{shortLabel}</span>
          <ChevronDown className="h-3.5 w-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 px-1 py-2" align="start">
        <div className="flex flex-col gap-1">
          {options.map((option) => {
            const isSelected = option.modelId === selected.modelId
            return (
              <button
                key={option.family}
                type="button"
                data-testid={`model-option-${option.family}`}
                onClick={() => {
                  onChange(option.modelId)
                  setOpen(false)
                }}
                className={cn(
                  'group flex items-start justify-between gap-2 rounded-sm px-2 py-1 text-left hover:bg-accent',
                  isSelected && 'bg-accent'
                )}
              >
                <span className="flex flex-col">
                  <span className="text-sm font-normal">{option.label}</span>
                  <span
                    className={cn(
                      'overflow-hidden text-xs font-normal text-muted-foreground transition-[max-height,opacity,margin-top] duration-500 ease-out',
                      isSelected
                        ? 'mt-0.5 max-h-16 opacity-100'
                        : 'mt-0 max-h-0 opacity-0 group-hover:mt-0.5 group-hover:max-h-16 group-hover:opacity-100'
                    )}
                  >
                    {FAMILY_BLURB[option.family] ?? ''}
                  </span>
                </span>
                {isSelected && (
                  <Check className="h-3.5 w-3.5 shrink-0 self-center text-foreground" />
                )}
              </button>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}
