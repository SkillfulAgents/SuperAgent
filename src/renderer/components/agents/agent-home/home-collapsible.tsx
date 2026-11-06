import { createContext, useContext, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@renderer/components/ui/collapsible'

/** How the settings cards look where they sit. Agent Home's by default; another page provides its own. */
export interface HomeCardLook {
  card: string
  section: string
  media: string
  label: string
  defaultOpen: boolean
}

export const HomeCardLookContext = createContext<HomeCardLook>({
  card: 'rounded-xl border bg-background',
  section: 'rounded-xl border bg-background py-4',
  media: '',
  label: 'text-sm font-medium text-muted-foreground',
  defaultOpen: true,
})

export const useHomeCardLook = () => useContext(HomeCardLookContext)

interface HomeCollapsibleProps {
  title: string
  children: ReactNode
  className?: string
}

export function HomeCollapsible({ title, children, className }: HomeCollapsibleProps) {
  const look = useHomeCardLook()
  return (
    <Collapsible defaultOpen={look.defaultOpen}>
      <div className={cn(look.section, className)}>
        <CollapsibleTrigger className="flex w-full items-center justify-between px-4">
          <span className={look.label}>{title}</span>
          <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform [[data-state=closed]>&]:rotate-[-90deg]" />
        </CollapsibleTrigger>
        <CollapsibleContent>
          {children}
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}
