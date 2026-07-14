import { memo } from 'react'
import { ChevronDown } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { Separator } from '@renderer/components/ui/separator'
import { ModelIcon } from '@renderer/components/ui/model-icon'
import { EFFORT_LEVELS } from '@shared/lib/container/types'
import { type ComposerOptionsState } from './composer-options'
import { ModelFamilyList, findCatalogModel } from './model-family-list'
import { EFFORT_LABELS, EffortSection, useEffortClamp } from './effort-slider'

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

  const effortLabel = EFFORT_LABELS[effort]
  const selectedModelLabel = selectedModel?.label
  const triggerAriaLabel = includeEffort
    ? (selectedModelLabel ? `${selectedModelLabel} · ${effortLabel}` : effortLabel)
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
                {selectedModelLabel ? ' · ' : ''}{effortLabel}
              </span>
            )}
          </span>
          <ChevronDown className="h-3.5 w-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="flex w-64 flex-col px-1 py-2 data-[side=bottom]:flex-col-reverse"
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
      </PopoverContent>
    </Popover>
  )
}

export const ComposerOptionsPopover = memo(ComposerOptionsPopoverImpl)
