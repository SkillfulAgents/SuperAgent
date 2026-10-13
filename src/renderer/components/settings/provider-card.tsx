import { type ReactNode } from 'react'
import { Lock } from 'lucide-react'

interface ProviderCardProps {
  id: string
  /** data-testid is `${testIdPrefix}-${id}`. */
  testIdPrefix: string
  name: string
  /** Rendered next to the name, e.g. the "(default)" marker. */
  nameSuffix?: ReactNode
  description?: ReactNode
  selected: boolean
  disabled?: boolean
  disabledReason?: string
  onSelect: () => void
  children?: ReactNode
}

/** Radio card that expands its provider-specific settings when selected —
    used by the Web Search and Decision Model tabs. */
export function ProviderCard({
  id,
  testIdPrefix,
  name,
  nameSuffix,
  description,
  selected,
  disabled = false,
  disabledReason,
  onSelect,
  children,
}: ProviderCardProps) {
  return (
    <div
      className={`rounded-xl border bg-background transition-colors ${
        selected ? 'border-primary' : disabled ? 'opacity-60' : 'hover:border-muted-foreground/40'
      }`}
      data-testid={`${testIdPrefix}-${id}`}
    >
      {/* A div rather than a <button>: descriptions may carry a real link, and
          interactive content inside a button is invalid HTML. */}
      <div
        role="radio"
        aria-checked={selected}
        aria-disabled={disabled || undefined}
        tabIndex={disabled ? -1 : 0}
        onClick={disabled ? undefined : onSelect}
        onKeyDown={(e) => {
          if (disabled) return
          // Ignore keys bubbling from inner interactive content (e.g. links).
          if (e.target !== e.currentTarget) return
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault()
            onSelect()
          }
        }}
        className={`w-full flex items-start gap-3 px-4 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
          disabled ? 'cursor-not-allowed' : 'cursor-pointer'
        }`}
      >
        <div
          className={`mt-0.5 h-4 w-4 rounded-full border-2 shrink-0 flex items-center justify-center ${
            selected ? 'border-primary' : 'border-muted-foreground/40'
          }`}
        >
          {selected && <div className="h-2 w-2 rounded-full bg-primary" />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{name}</span>
            {nameSuffix}
            {disabled && disabledReason && (
              <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                <Lock className="h-3 w-3" />
                {disabledReason}
              </span>
            )}
          </div>
          {description && (
            <div className="text-[11px] text-muted-foreground mt-0.5">{description}</div>
          )}
        </div>
      </div>

      {/* Expanded settings area when selected */}
      <div
        className={`grid transition-all duration-200 ease-in-out ${
          selected && children ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
        }`}
      >
        <div className="overflow-hidden">
          {/* Only mount when selected: a collapsed grid-rows-[0fr] still leaves
              inputs in the DOM and keyboard tab order, so render conditionally. */}
          {selected && children && (
            <div className="px-4 pb-6 pt-5 border-t border-border/50">{children}</div>
          )}
        </div>
      </div>
    </div>
  )
}
