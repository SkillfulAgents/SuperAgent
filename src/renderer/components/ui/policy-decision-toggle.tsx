import { CircleCheck, Hand, Ban } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip'

type PolicyDecision = 'allow' | 'review' | 'block' | 'default'

interface PolicyDecisionToggleProps {
  value: PolicyDecision
  onChange: (value: PolicyDecision) => void
  size?: 'sm' | 'md'
}

const options = [
  {
    value: 'allow' as const,
    icon: CircleCheck,
    label: 'Allow',
    activeClasses: 'bg-green-600 text-white',
    hoverClasses: 'hover:bg-green-100 dark:hover:bg-green-900/40 text-muted-foreground',
  },
  {
    value: 'review' as const,
    icon: Hand,
    label: 'Review',
    activeClasses: 'bg-blue-600 text-white',
    hoverClasses: 'hover:bg-blue-100 dark:hover:bg-blue-900/40 text-muted-foreground',
  },
  {
    value: 'block' as const,
    icon: Ban,
    label: 'Block',
    activeClasses: 'bg-orange-600 text-white',
    hoverClasses: 'hover:bg-orange-100 dark:hover:bg-orange-900/40 text-muted-foreground',
  },
] as const

export function PolicyDecisionToggle({
  value,
  onChange,
  size = 'sm',
}: PolicyDecisionToggleProps) {
  const iconSize = size === 'sm' ? 'h-3.5 w-3.5' : 'h-4 w-4'
  const btnSize = size === 'sm' ? 'h-6 w-7' : 'h-7 w-8'

  return (
    <TooltipProvider delayDuration={300}>
      <div className="inline-flex items-center rounded-md border bg-muted/50 p-0.5 gap-0.5">
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
                  onClick={() => onChange(isActive ? 'default' : opt.value)}
                  className={cn(
                    'inline-flex items-center justify-center rounded-sm transition-colors',
                    btnSize,
                    isActive ? opt.activeClasses : opt.hoverClasses
                  )}
                >
                  <Icon className={iconSize} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">
                {isActive ? `Remove ${opt.label.toLowerCase()} (set to default)` : opt.label}
              </TooltipContent>
            </Tooltip>
          )
        })}
      </div>
    </TooltipProvider>
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
      return <CircleCheck className={cn(iconClass, 'text-green-600')} />
    case 'review':
      return <Hand className={cn(iconClass, 'text-blue-600')} />
    case 'block':
      return <Ban className={cn(iconClass, 'text-orange-600')} />
    default:
      return null
  }
}
