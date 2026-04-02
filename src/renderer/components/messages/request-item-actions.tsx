import type { ReactNode } from 'react'
import { cn } from '@shared/lib/utils/cn'

interface RequestItemActionsProps {
  children: ReactNode
  className?: string
}

export function RequestItemActions({ children, className }: RequestItemActionsProps) {
  return (
    <div className={cn('flex justify-end gap-2 pt-8', className)}>
      {children}
    </div>
  )
}
