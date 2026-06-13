import type { ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@renderer/components/ui/collapsible'

interface HomeCollapsibleProps {
  title: string
  defaultOpen?: boolean
  children: ReactNode
  className?: string
}

export function HomeCollapsible({ title, defaultOpen = true, children, className }: HomeCollapsibleProps) {
  return (
    <Collapsible defaultOpen={defaultOpen}>
      <div className={cn("rounded-xl border bg-background py-4", className)}>
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
