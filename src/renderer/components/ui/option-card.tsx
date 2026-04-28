import type { ReactNode } from 'react'
import { ArrowRight } from 'lucide-react'

export interface OptionCardProps {
  title: string
  description: ReactNode
  icon: ReactNode
  /** Color treatment for the circular icon badge. */
  iconTone?: 'blue' | 'neutral'
  /** Action label kept for accessibility — not rendered visibly. */
  buttonLabel: string
  /** Optional metadata chip displayed at the bottom of the card. */
  pill?: ReactNode
  onClick: () => void
  className?: string
}

const ICON_TONES = {
  blue: 'bg-blue-100 text-blue-600 dark:bg-blue-500/15 dark:text-blue-400',
  neutral: 'bg-muted text-foreground dark:bg-muted dark:text-foreground',
} as const

export function OptionCard({
  title,
  description,
  icon,
  iconTone = 'blue',
  buttonLabel,
  pill,
  onClick,
  className,
}: OptionCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${title} — ${buttonLabel}`}
      className={`group text-left rounded-2xl border border-border/50 p-4 flex flex-col items-stretch cursor-pointer w-fit hover:w-[280px] focus-visible:w-[280px] hover:border-foreground/30 hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-[width,background-color,border-color] duration-200 ease-out ${className ?? ''}`}
    >
      <div className="flex items-center gap-2">
        <span className={`inline-flex h-6 w-6 items-center justify-center rounded-full ${ICON_TONES[iconTone]}`}>
          {icon}
        </span>
        <span className="text-xs font-medium whitespace-nowrap">{title}</span>
      </div>
      <div className="w-0 min-w-full grid grid-rows-[0fr] group-hover:grid-rows-[1fr] group-focus-visible:grid-rows-[1fr] mt-0 group-hover:mt-1.5 group-focus-visible:mt-1.5 transition-[grid-template-rows,margin] duration-200 ease-out">
        <div className="overflow-hidden">
          <p className="text-xs text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity duration-200">
            {description}
          </p>
        </div>
      </div>
      <div className="w-0 min-w-full grid grid-rows-[0fr] group-hover:grid-rows-[1fr] group-focus-visible:grid-rows-[1fr] mt-0 group-hover:mt-4 group-focus-visible:mt-4 transition-[grid-template-rows,margin] duration-200 ease-out">
        <div className="overflow-hidden">
          <div className="flex items-center justify-between gap-2 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity duration-200">
            {pill ? (
              <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[11px] text-foreground">
                {pill}
              </span>
            ) : <span />}
            <span className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-foreground hover:bg-accent hover:text-accent-foreground transition-colors">
              {buttonLabel}
              <ArrowRight className="h-3 w-3" />
            </span>
          </div>
        </div>
      </div>
    </button>
  )
}
