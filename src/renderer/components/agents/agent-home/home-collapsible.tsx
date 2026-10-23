import type { ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@renderer/components/ui/collapsible'

interface HomeCollapsibleProps {
  title: string
  defaultOpen?: boolean
  /** Beside the chevron, so a folded card still says what is in it (a few logos and a count, say). */
  summary?: ReactNode
  children: ReactNode
  className?: string
  /** On the card; its header gets `${testId}-toggle`. */
  testId?: string
}

export function HomeCollapsible({ title, defaultOpen = true, summary, children, className, testId }: HomeCollapsibleProps) {
  return (
    <Collapsible defaultOpen={defaultOpen}>
      <div className={cn("rounded-xl border bg-background py-4", className)} data-testid={testId}>
        <CollapsibleTrigger className="flex w-full items-center justify-between px-4" data-testid={testId && `${testId}-toggle`}>
          <span className="text-sm font-medium text-muted-foreground">{title}</span>
          {summary !== undefined && <span className="ml-auto mr-2 flex items-center gap-2">{summary}</span>}
          <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform [[data-state=closed]>&]:rotate-[-90deg]" />
        </CollapsibleTrigger>
        <CollapsibleContent>
          {children}
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}
