import type { ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@renderer/components/ui/collapsible'

interface HomeCollapsibleProps {
  title: string
  defaultOpen?: boolean
  children: ReactNode
}

export function HomeCollapsible({ title, defaultOpen = true, children }: HomeCollapsibleProps) {
  return (
    <Collapsible defaultOpen={defaultOpen}>
      <div className="rounded-xl border bg-background py-4">
        <CollapsibleTrigger className="flex w-full items-center justify-between px-4">
          <span className="text-sm font-medium text-muted-foreground">{title}</span>
          <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform [[data-state=closed]>&]:rotate-[-90deg]" />
        </CollapsibleTrigger>
        <CollapsibleContent>
          {children}
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}
