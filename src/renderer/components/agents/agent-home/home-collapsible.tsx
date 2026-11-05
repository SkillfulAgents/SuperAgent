import type { ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@renderer/components/ui/collapsible'
import { HOME_GLASS_SURFACE_CLASS } from './home-glass-panel'

/**
 * The one card the Agent Home sections (Triggers, Connections, Skills, …) share.
 * Each section is a row in it, divided from the next; the card clips the rows
 * to its rounded corners so a header's hover fill stays inside.
 */
export function HomePanel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      // Glass, like the main column's panels, so the background shows through it.
      className={cn('overflow-hidden rounded-card divide-y divide-border/50', HOME_GLASS_SURFACE_CLASS, className)}
      data-testid="home-sections-panel"
    >
      {children}
    </div>
  )
}

/**
 * A section header row: muted 12px title on the left, chevron on the right.
 * Shared with the "Show more" toggle below the panel so it reads as
 * one more section label. The focus ring is inset because the panel clips its
 * rows to the rounded corners.
 */
export const HOME_SECTION_HEADER_CLASS = 'flex min-h-12 w-full items-center justify-between px-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring'

interface HomeCollapsibleProps {
  title: string
  /** How many items the section holds, shown while it is collapsed. Omit until known. */
  count?: number
  defaultOpen?: boolean
  children: ReactNode
  className?: string
}

/**
 * A section row in the HomePanel: a header the height of the HomeExtras rows,
 * collapsed by default, that opens to the section's content below it.
 */
export function HomeCollapsible({ title, count, defaultOpen = false, children, className }: HomeCollapsibleProps) {
  return (
    <Collapsible defaultOpen={defaultOpen} className={className}>
      <CollapsibleTrigger className={HOME_SECTION_HEADER_CLASS}>
        <span className="text-[12px]/5 text-muted-foreground">{title}</span>
        <span className="flex items-center gap-2">
          {count !== undefined && (
            // aria-hidden: the header's name stays the section title.
            <span aria-hidden="true" className="text-[12px]/5 tabular-nums text-muted-foreground/50 [[data-state=open]>*>&]:hidden" data-testid="home-section-count">
              {count}
            </span>
          )}
          <ChevronDown className="h-4 w-4 text-muted-foreground/50 transition-transform [[data-state=closed]>*>&]:rotate-[-90deg]" />
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="pb-3">
        {children}
      </CollapsibleContent>
    </Collapsible>
  )
}
