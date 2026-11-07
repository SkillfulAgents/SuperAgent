import { useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@renderer/components/ui/collapsible'
import { HOME_GLASS_SURFACE_CLASS } from './home-glass-panel'
import { useUpdateUserSettings, useUserSettings } from '@renderer/hooks/use-user-settings'

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
 * What a section shows when it has nothing in it: plain text in the section,
 * on the rows' 16px inset, with no box of its own (the panel is already one).
 * `children` adds anything below the description, like setup tiles.
 */
export function HomeEmptyState({ title, description, children }: { title: string; description: ReactNode; children?: ReactNode }) {
  return (
    <div className="px-4 pb-1">
      {/* Quiet: an empty section is a note, not content. */}
      <p className="text-xs font-normal text-muted-foreground">{title}</p>
      <p className="mt-0.5 text-xs text-muted-foreground/70">{description}</p>
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

/** The Agent Home sections, by the id their open state is stored under (user setting `agentHomeSectionsOpen`). */
export type HomeSectionId = 'triggers' | 'connections' | 'skills' | 'integrations' | 'drives' | 'hooks'

interface HomeCollapsibleProps {
  /** Where its open state is stored, so it opens as the user last left it, on every agent. */
  id: HomeSectionId
  title: string
  /** How many items the section holds, shown while it is collapsed. Omit until known. */
  count?: number
  /** Open until the user has opened or closed it themselves. */
  defaultOpen?: boolean
  children: ReactNode
  className?: string
}

/**
 * A section row in the HomePanel: a header the height of the HomeExtras rows
 * that opens to the section's content below it. It opens as the user last left
 * it (a user setting, shared by every agent's Agent Home), collapsed until then.
 * The local override answers at once while the settings write round-trips.
 */
export function HomeCollapsible({ id, title, count, defaultOpen = false, children, className }: HomeCollapsibleProps) {
  const { data: userSettings } = useUserSettings()
  const { mutate: mutateSettings } = useUpdateUserSettings()
  const [override, setOverride] = useState<boolean | null>(null)
  const open = override ?? userSettings?.agentHomeSectionsOpen?.[id] ?? defaultOpen
  const setOpen = (next: boolean) => {
    setOverride(next)
    // The function form merges into the latest stored map, so toggling two sections quickly keeps both.
    mutateSettings((current) => ({ agentHomeSectionsOpen: { ...current.agentHomeSectionsOpen, [id]: next } }))
  }
  return (
    <Collapsible open={open} onOpenChange={setOpen} className={className}>
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
