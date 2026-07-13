import { memo, useEffect, useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { Separator } from '@renderer/components/ui/separator'
import { ModelIcon } from '@renderer/components/ui/model-icon'
import { EFFORT_LEVELS } from '@shared/lib/container/types'
import { type ComposerOptionsState } from './composer-options'
import { ModelFamilyList, findCatalogModel } from './model-family-list'
import { EFFORT_LABELS, EffortSection } from './effort-slider'

function SectionHeader({ children }: { children: ReactNode }) {
  return (
    <div className="px-2 pt-1 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
      {children}
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

  const effortLabel = EFFORT_LABELS[effort]
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
              webProvider={webProvider}
            />
            {includeEffort && <Separator className="my-2" />}
          </>
        )}
        {includeEffort && (
          /* Effort changes never dismiss — the slider invites adjustment. */
          <EffortSection levels={visibleEfforts} value={effort} onChange={setEffort} />
        )}
      </PopoverContent>
    </Popover>
  )
}

export const ComposerOptionsPopover = memo(ComposerOptionsPopoverImpl)
