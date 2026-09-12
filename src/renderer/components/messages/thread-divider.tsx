import type { HTMLAttributes } from 'react'
import { cn } from '@shared/lib/utils/cn'

/**
 * A rule across the thread with a label in the middle: the compaction
 * boundary, the voice-mode switch, and the fork point are all drawn this way.
 * Callers own the label (an icon and text, or a toggle button).
 */
export function ThreadDivider({ children, className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('flex items-center gap-2 px-4', className)} {...rest}>
      <div className="flex-1 border-t border-dashed border-muted-foreground/30" />
      {children}
      <div className="flex-1 border-t border-dashed border-muted-foreground/30" />
    </div>
  )
}
