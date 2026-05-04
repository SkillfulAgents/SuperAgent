import { memo, useEffect, useState, type ReactNode } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { Separator } from '@renderer/components/ui/separator'
import { cn } from '@shared/lib/utils'
import { EFFORT_LEVELS, type EffortLevel } from '@shared/lib/container/types'
import type { ComposerModelFamily } from '@shared/lib/llm-provider'
import type { ComposerOptionsState } from './composer-options'

const FAMILY_LABEL: Record<ComposerModelFamily, string> = {
  opus: 'Opus 4.7',
  sonnet: 'Sonnet 4.6',
  haiku: 'Haiku 4.5',
}

const FAMILY_BLURB: Record<ComposerModelFamily, string> = {
  haiku: 'Fastest and cheapest. Good for quick or simple tasks.',
  sonnet: 'Balanced speed and capability.',
  opus: 'Most capable. Best for complex, long-horizon work.',
}

const EFFORT_META: Record<EffortLevel, { label: string; blurb: string }> = {
  low: { label: 'Low', blurb: 'Fastest. Minimal thinking, terse answers.' },
  medium: { label: 'Medium', blurb: 'Balanced thinking and response depth.' },
  high: { label: 'High', blurb: 'Default. Thorough planning and explanations.' },
  xhigh: { label: 'Extra High', blurb: 'Deep reasoning for long-horizon work.' },
  max: { label: 'Max', blurb: 'Highest effort.' },
}

const EFFORT_FAMILY_REQUIREMENTS: Partial<Record<EffortLevel, ComposerModelFamily[]>> = {
  xhigh: ['opus'],
  max: ['opus'],
}

function isEffortAllowed(level: EffortLevel, family: ComposerModelFamily | undefined): boolean {
  const required = EFFORT_FAMILY_REQUIREMENTS[level]
  if (!required) return true
  if (!family) return false
  return required.includes(family)
}

function SectionHeader({ children }: { children: ReactNode }) {
  return (
    <div className="px-2 pt-1 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
      {children}
    </div>
  )
}

interface OptionRowProps {
  label: string
  blurb: string
  isSelected: boolean
  onClick: () => void
  testId: string
}

function OptionRow({ label, blurb, isSelected, onClick, testId }: OptionRowProps) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className={cn(
        'group flex items-start justify-between gap-2 rounded-sm px-2 py-1 text-left hover:bg-accent',
        isSelected && 'bg-accent'
      )}
    >
      <span className="flex flex-col">
        <span className="text-xs font-normal">{label}</span>
        <span
          className={cn(
            'overflow-hidden text-xs font-normal text-muted-foreground transition-[max-height,opacity,margin-top] duration-500 ease-out',
            isSelected
              ? 'mt-0.5 max-h-16 opacity-100'
              : 'mt-0 max-h-0 opacity-0 group-hover:mt-0.5 group-hover:max-h-16 group-hover:opacity-100'
          )}
        >
          {blurb}
        </span>
      </span>
      {isSelected && (
        <Check className="h-3.5 w-3.5 shrink-0 self-center text-foreground" />
      )}
    </button>
  )
}

interface ComposerOptionsPopoverProps {
  state: ComposerOptionsState
  disabled?: boolean
}

function ComposerOptionsPopoverImpl({ state, disabled }: ComposerOptionsPopoverProps) {
  const { effort, setEffort, model, setModel, composerModels } = state
  const [open, setOpen] = useState(false)

  // Trigger display fallback for the brief window before useComposerOptions
  // seeds `model`. Prefer Sonnet (the codebase-wide default) over the first
  // option so we don't flash Haiku on initial mount.
  const selectedModel =
    composerModels.find((m) => m.modelId === model)
    ?? composerModels.find((m) => m.family === 'sonnet')
    ?? composerModels[0]
  const selectedFamily = selectedModel?.family

  // Reset to High whenever the new family disallows the current effort. High
  // is the universal default (no family restriction) so it's always safe.
  useEffect(() => {
    if (selectedFamily && !isEffortAllowed(effort, selectedFamily)) {
      setEffort('high')
    }
  }, [selectedFamily, effort, setEffort])

  const visibleEfforts = EFFORT_LEVELS.filter((level) =>
    selectedFamily ? isEffortAllowed(level, selectedFamily) : true
  )

  const effortLabel = EFFORT_META[effort].label
  const selectedModelLabel = selectedModel ? FAMILY_LABEL[selectedModel.family] : undefined
  const triggerAriaLabel = selectedModelLabel
    ? `${selectedModelLabel} · ${effortLabel}`
    : effortLabel

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          className="h-[34px] gap-1.5 px-2 text-xs font-medium"
          aria-label={`Model and effort: ${triggerAriaLabel}. Click to change.`}
          data-testid="composer-options-trigger"
        >
          <span>
            {selectedModelLabel}
            <span className="text-muted-foreground">
              {selectedModelLabel ? ' · ' : ''}{effortLabel}
            </span>
          </span>
          <ChevronDown className="h-3.5 w-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 px-1 py-2" align="start">
        {selectedModel && (
          <>
            <SectionHeader>Models</SectionHeader>
            <div className="flex flex-col gap-1">
              {composerModels.map((option) => (
                <OptionRow
                  key={option.family}
                  label={FAMILY_LABEL[option.family]}
                  blurb={FAMILY_BLURB[option.family]}
                  isSelected={option.modelId === selectedModel.modelId}
                  onClick={() => {
                    setModel(option.modelId)
                    setOpen(false)
                  }}
                  testId={`model-option-${option.family}`}
                />
              ))}
            </div>
            <Separator className="my-2" />
          </>
        )}
        <SectionHeader>Effort</SectionHeader>
        <div className="flex flex-col gap-1">
          {visibleEfforts.map((level) => (
            <OptionRow
              key={level}
              label={EFFORT_META[level].label}
              blurb={EFFORT_META[level].blurb}
              isSelected={effort === level}
              onClick={() => {
                setEffort(level)
                setOpen(false)
              }}
              testId={`effort-option-${level}`}
            />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

export const ComposerOptionsPopover = memo(ComposerOptionsPopoverImpl)
