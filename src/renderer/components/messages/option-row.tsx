import { type ReactNode } from 'react'
import { Check } from 'lucide-react'
import { cn } from '@shared/lib/utils'

export interface OptionRowProps {
  label: string
  blurb: string
  onClick: () => void
  testId: string
  /** Persistent selection: tints the row, keeps the blurb open, and renders a check. */
  isSelected?: boolean
  /** Keep the blurb open at rest (no hover needed) without the selected tint/check —
   *  e.g. forward-action rows where the description should always be visible. */
  alwaysShowBlurb?: boolean
  /** Trailing affordance shown when the row is not selected (e.g. a forward chevron).
   *  The node controls its own hover reveal via its own classes. Ignored when selected. */
  trailing?: ReactNode
  disabled?: boolean
}

/**
 * Compact menu row: a label with a blurb that expands beneath it (a 500ms
 * max-height/opacity transition) on hover, or stays open while selected. Selected
 * rows tint and show a check; unselected rows can carry a custom `trailing` node.
 *
 * Shared by the composer model/effort picker (composer-options-popover) and the
 * stale-session New conversation menu so both read as one system.
 */
export function OptionRow({
  label,
  blurb,
  onClick,
  testId,
  isSelected = false,
  alwaysShowBlurb = false,
  trailing,
  disabled = false,
}: OptionRowProps) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'group flex items-start justify-between gap-2 rounded-sm px-2 py-1 text-left hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60',
        isSelected && 'bg-accent'
      )}
    >
      <span className="flex flex-col">
        <span className="text-xs font-normal">{label}</span>
        <span
          className={cn(
            'overflow-hidden text-xs font-normal text-muted-foreground transition-[max-height,opacity,margin-top] duration-500 ease-out',
            isSelected || alwaysShowBlurb
              ? 'mt-0.5 max-h-16 opacity-100'
              : 'mt-0 max-h-0 opacity-0 group-hover:mt-0.5 group-hover:max-h-16 group-hover:opacity-100'
          )}
        >
          {blurb}
        </span>
      </span>
      {isSelected ? <Check className="h-3.5 w-3.5 shrink-0 self-center text-foreground" /> : trailing}
    </button>
  )
}
