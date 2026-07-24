import { useState } from 'react'
import { CircleCheckBig, Hand, Ban, ChevronDown, CircleDashed } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@renderer/components/ui/popover'

type PolicyDecision = 'allow' | 'review' | 'block' | 'default'

interface PolicyDecisionToggleProps {
  value: PolicyDecision
  onChange: (value: PolicyDecision) => void
  size?: 'sm' | 'md'
  /**
   * When false, clicking the active option is a no-op instead of resetting to
   * 'default' — for strict three-way policies with no inherit tier.
   */
  allowDeselect?: boolean
}

const options = [
  {
    value: 'allow' as const,
    icon: CircleCheckBig,
    label: 'Allow',
    tooltip: 'Always allow',
    activeColor: 'text-green-600 dark:text-green-400',
  },
  {
    value: 'review' as const,
    icon: Hand,
    label: 'Review',
    tooltip: 'Needs approval',
    activeColor: 'text-blue-600 dark:text-blue-400',
  },
  {
    value: 'block' as const,
    icon: Ban,
    label: 'Block',
    tooltip: 'Blocked',
    activeColor: 'text-orange-600 dark:text-orange-400',
  },
] as const

export function PolicyDecisionToggle({
  value,
  onChange,
  size = 'sm',
  allowDeselect = true,
}: PolicyDecisionToggleProps) {
  const iconSize = size === 'sm' ? 'h-3.5 w-3.5' : 'h-4 w-4'
  const btnSize = size === 'sm' ? 'h-6 w-7' : 'h-7 w-8'

  return (
    <TooltipProvider delayDuration={300}>
      <div className="inline-flex items-center rounded-md bg-muted p-0.5 gap-0.5 text-muted-foreground">
        {options.map((opt) => {
          const isActive = value === opt.value
          const Icon = opt.icon
          return (
            <Tooltip key={opt.value}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  data-testid={`policy-toggle-${opt.value}`}
                  data-active={isActive}
                  aria-label={opt.label}
                  aria-pressed={isActive}
                  onClick={() => {
                    if (isActive && !allowDeselect) return
                    onChange(isActive ? 'default' : opt.value)
                  }}
                  className={cn(
                    'inline-flex items-center justify-center rounded-sm transition-colors',
                    btnSize,
                    isActive
                      ? cn('bg-background shadow', opt.activeColor)
                      : 'hover:text-foreground'
                  )}
                >
                  <Icon className={iconSize} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">
                {isActive && allowDeselect ? `Remove ${opt.label.toLowerCase()} (set to default)` : opt.tooltip}
              </TooltipContent>
            </Tooltip>
          )
        })}
      </div>
    </TooltipProvider>
  )
}

/**
 * Compact dropdown variant of the policy control: the trigger shows the current
 * decision's icon and a chevron; the menu offers the three decisions plus
 * "Default" (inherit). Used where a full segmented toggle is too heavy — e.g.
 * scope-group headers.
 */
export function PolicyDecisionDropdown({
  value,
  onChange,
  className,
}: {
  value: PolicyDecision
  onChange: (value: PolicyDecision) => void
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const current = options.find((o) => o.value === value)
  const CurrentIcon = current?.icon
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="policy-dropdown-trigger"
          data-decision={value}
          className={cn(
            'flex h-7 w-36 items-center gap-1.5 whitespace-nowrap rounded-md border border-input bg-transparent px-2 text-xs shadow-sm focus:outline-none focus:ring-1 focus:ring-ring',
            className,
          )}
        >
          {current && CurrentIcon ? (
            <CurrentIcon className={cn('h-3.5 w-3.5 shrink-0', current.activeColor)} />
          ) : (
            <CircleDashed className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )}
          {current ? current.tooltip : 'Default'}
          <ChevronDown className="ml-auto h-3.5 w-3.5 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-40 p-1">
        {options.map((opt) => {
          const Icon = opt.icon
          return (
            <button
              key={opt.value}
              type="button"
              data-testid={`policy-menu-${opt.value}`}
              data-active={value === opt.value}
              onClick={() => {
                onChange(opt.value)
                setOpen(false)
              }}
              className={cn(
                'flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-muted',
                value === opt.value && 'bg-muted',
              )}
            >
              <Icon className={cn('h-3.5 w-3.5', opt.activeColor)} />
              {opt.tooltip}
            </button>
          )
        })}
        <button
          type="button"
          data-testid="policy-menu-default"
          data-active={value === 'default'}
          onClick={() => {
            onChange('default')
            setOpen(false)
          }}
          className={cn(
            'flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-muted',
            value === 'default' && 'bg-muted',
          )}
        >
          <CircleDashed className="h-3.5 w-3.5 text-muted-foreground" />
          Default
        </button>
      </PopoverContent>
    </Popover>
  )
}

/** Small inline icon for displaying a policy decision (read-only). */
export function PolicyDecisionIcon({
  decision,
  className,
}: {
  decision: PolicyDecision
  className?: string
}) {
  const iconClass = cn('h-3.5 w-3.5', className)
  switch (decision) {
    case 'allow':
      return <CircleCheckBig className={cn(iconClass, 'text-green-600')} />
    case 'review':
      return <Hand className={cn(iconClass, 'text-blue-600')} />
    case 'block':
      return <Ban className={cn(iconClass, 'text-orange-600')} />
    default:
      return null
  }
}
