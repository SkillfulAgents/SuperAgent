import { memo, useEffect, useState, type ReactNode } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { Separator } from '@renderer/components/ui/separator'
import { ModelIcon } from '@renderer/components/ui/model-icon'
import { cn } from '@shared/lib/utils'
import { EFFORT_LEVELS, type EffortLevel } from '@shared/lib/container/types'
import { type ComposerOptionsState } from './composer-options'
import { ModelFamilyList, findCatalogModel } from './model-family-list'

const EFFORT_META: Record<EffortLevel, { label: string; blurb: string }> = {
  low: { label: 'Low', blurb: 'Fastest. Minimal thinking, terse answers.' },
  medium: { label: 'Medium', blurb: 'Default. Balanced thinking and response depth.' },
  high: { label: 'High', blurb: 'Thorough planning and explanations.' },
  xhigh: { label: 'Extra High', blurb: 'Deep reasoning for long-horizon work.' },
  max: { label: 'Max', blurb: 'Highest effort.' },
}

function SectionHeader({ children }: { children: ReactNode }) {
  return (
    <div className="px-2 pt-1 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
      {children}
    </div>
  )
}

interface EffortRowProps {
  label: string
  blurb: string
  isSelected: boolean
  onClick: () => void
  testId: string
}

function EffortRow({ label, blurb, isSelected, onClick, testId }: EffortRowProps) {
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
      <span className="flex min-w-0 flex-col">
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
  /** Show the Effort section. Disable for model-only pickers (e.g. summarizer). */
  includeEffort?: boolean
}

function ComposerOptionsPopoverImpl({ state, disabled, includeEffort = true }: ComposerOptionsPopoverProps) {
  const { effort, setEffort, model, setModel, catalog, webSearchProvider, webFetchProvider } = state
  const [open, setOpen] = useState(false)

  // Trigger display fallback for the brief window before useComposerOptions
  // seeds `model`. Order: resolve the selection against the catalog (exact id
  // or family-latest) → the catalog's latest Sonnet (codebase-wide default,
  // beats falling through to the first entry) → first entry.
  const selectedModel =
    findCatalogModel(model, catalog)
    ?? catalog.find((m) => m.family === 'sonnet' && m.isLatest)
    ?? catalog[0]

  // Reset to Medium whenever the selected model disallows the current effort.
  // Medium is the default effort and every model supports it, so it's safe.
  const supportsCurrentEffort = selectedModel?.supportedEfforts.includes(effort) ?? true
  useEffect(() => {
    if (includeEffort && selectedModel && !supportsCurrentEffort) {
      setEffort('medium')
    }
  }, [includeEffort, selectedModel, supportsCurrentEffort, setEffort])

  const visibleEfforts = EFFORT_LEVELS.filter((level) =>
    selectedModel ? selectedModel.supportedEfforts.includes(level) : true
  )

  const effortLabel = EFFORT_META[effort].label
  const selectedModelLabel = selectedModel?.label
  const triggerAriaLabel = includeEffort
    ? (selectedModelLabel ? `${selectedModelLabel} · ${effortLabel}` : effortLabel)
    : (selectedModelLabel ?? 'Model')

  return (
    <Popover open={open} onOpenChange={setOpen}>
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
                {selectedModelLabel ? ' · ' : ''}{effortLabel}
              </span>
            )}
          </span>
          <ChevronDown className="h-3.5 w-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 px-1 py-2" align="start">
        {selectedModel && (
          <>
            <SectionHeader>Models</SectionHeader>
            {/* Grouped by family, no "latest" — per-message picks a concrete version. */}
            <ModelFamilyList
              catalog={catalog}
              value={model}
              onPick={(value) => {
                setModel(value)
                setOpen(false)
              }}
              // One click on a family selects its latest and expands (no close),
              // so the 90% who just want the latest are done in a single click.
              onSelectFamilyLatest={(value) => setModel(value)}
              webSearchProvider={webSearchProvider}
              webFetchProvider={webFetchProvider}
            />
            {includeEffort && <Separator className="my-2" />}
          </>
        )}
        {includeEffort && (
          <>
            <SectionHeader>Effort</SectionHeader>
            <div className="flex flex-col gap-1">
              {visibleEfforts.map((level) => (
                <EffortRow
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
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}

export const ComposerOptionsPopover = memo(ComposerOptionsPopoverImpl)
