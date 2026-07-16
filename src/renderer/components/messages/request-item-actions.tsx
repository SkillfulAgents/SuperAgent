import type { ReactNode } from 'react'
import { cn } from '@shared/lib/utils/cn'

interface RequestItemActionsProps {
  children: ReactNode
  className?: string
}

export function RequestItemActions({ children, className }: RequestItemActionsProps) {
  return (
    <div
      className={cn(
        'sticky bottom-0 z-10 -mx-4 -mb-4 flex justify-end gap-2 border-t border-border bg-background px-4 pb-4 pt-4',
        className
      )}
    >
      {children}
    </div>
  )
}
