import { useState, type ReactElement, type ReactNode } from 'react'
import { ChevronDown, Info } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { cn } from '@shared/lib/utils/cn'
import { DeclineButton } from './decline-button'

const EXPANDED_CLASS = 'bg-orange-600 text-white hover:bg-orange-700'

const HINT_ICON = <Info aria-hidden className="!size-3 shrink-0 text-muted-foreground/40" />

/** Shows a grant's explanation when its button is hovered or focused. */
function InfoHint({ text, side = 'right', children }: { text: string; side?: 'right' | 'top'; children: ReactElement }) {
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent side={side} className="max-w-[240px] text-xs font-normal">
          {text}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

export interface ApprovalOption {
  label: ReactNode
  /** What the grant covers and for how long. */
  hint: string
  onSelect: () => void
  testId: string
}

/** The wider or longer grant: one button, or a menu when there is more than one. */
export type ExpandedGrant =
  | { label: string; hint: string; onSelect: () => void }
  | { label: string; options: ApprovalOption[] }

interface ApprovalActionsProps {
  testIdPrefix: string
  disabled?: boolean
  onDeny: (reason?: string) => void
  /** The narrow grant: the smallest one people use on this card. */
  onAllow: () => void
  denyLabel?: string
  allowLabel?: string
  /** None leaves the narrow grant as the one orange button. */
  expanded?: ExpandedGrant
  /** Below the options. Gets the close function so a link can close the menu. */
  footer?: (closeMenu: () => void) => ReactNode
}

/** Deny · narrow grant · expanded grant. Render it inside the card's `RequestItemActions`, which the shell lifts into its fixed footer. */
export function ApprovalActions({
  testIdPrefix,
  disabled,
  onDeny,
  onAllow,
  denyLabel = 'Deny',
  allowLabel = 'Allow Once',
  expanded,
  footer,
}: ApprovalActionsProps) {
  const [menuOpen, setMenuOpen] = useState(false)

  return (
    <>
      <DeclineButton
        onDecline={onDeny}
        disabled={disabled}
        label={denyLabel}
        showIcon={false}
        className="border-border text-foreground hover:bg-muted"
        data-testid={`${testIdPrefix}-deny-btn`}
      />

      <Button
        data-testid={`${testIdPrefix}-allow-once-btn`}
        onClick={onAllow}
        disabled={disabled}
        size="xs"
        variant={expanded ? 'outline' : 'default'}
        className={expanded ? 'border-border text-foreground hover:bg-muted' : EXPANDED_CLASS}
      >
        {allowLabel}
      </Button>

      {expanded && ('options' in expanded ? (
        <Popover open={menuOpen} onOpenChange={setMenuOpen}>
          <PopoverTrigger asChild>
            <Button
              disabled={disabled}
              size="xs"
              className={cn('min-w-24 pr-2', EXPANDED_CLASS)}
              data-testid={`${testIdPrefix}-always-allow-btn`}
            >
              <span>{expanded.label}</span>
              <ChevronDown className={cn('ml-1.5 h-3.5 w-3.5 transition-transform', menuOpen && 'rotate-180')} />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            className="w-auto max-w-[min(380px,calc(100vw-2rem))] p-1"
            // Focusing the first option would open its hint on every open.
            onOpenAutoFocus={(e) => {
              e.preventDefault()
              if (e.currentTarget instanceof HTMLElement) e.currentTarget.focus()
            }}
          >
            <div className="flex flex-col items-start gap-0">
              {expanded.options.map((option) => (
                <InfoHint key={option.testId} text={option.hint}>
                  <Button
                    data-testid={option.testId}
                    onClick={() => {
                      setMenuOpen(false)
                      option.onSelect()
                    }}
                    disabled={disabled}
                    variant="ghost"
                    size="xs"
                    className="h-auto min-w-0 w-full justify-start py-2 text-foreground hover:bg-muted"
                  >
                    <span className="flex w-full min-w-0 items-center gap-1 overflow-hidden text-left">
                      {option.label}
                      {HINT_ICON}
                    </span>
                  </Button>
                </InfoHint>
              ))}
              {footer?.(() => setMenuOpen(false))}
            </div>
          </PopoverContent>
        </Popover>
      ) : (
        // Above, so the hint never covers the other buttons in the bar.
        <InfoHint text={expanded.hint} side="top">
          <Button
            onClick={expanded.onSelect}
            disabled={disabled}
            size="xs"
            className={EXPANDED_CLASS}
            data-testid={`${testIdPrefix}-always-allow-btn`}
          >
            {expanded.label}
          </Button>
        </InfoHint>
      ))}
    </>
  )
}
