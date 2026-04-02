import type { ReactNode } from 'react'
import { cn } from '@shared/lib/utils/cn'

interface RequestTitleChipProps {
  children: ReactNode
  icon: ReactNode
  className?: string
}

export function RequestTitleChip({ children, icon, className }: RequestTitleChipProps) {
  return (
    <div
      className={cn(
        'inline-flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs font-medium',
        className
      )}
    >
      <span className="shrink-0 [&>svg]:h-3.5 [&>svg]:w-3.5">{icon}</span>
      <span>{children}</span>
    </div>
  )
}
