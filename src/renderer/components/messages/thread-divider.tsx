import type { HTMLAttributes } from 'react'
import { cn } from '@shared/lib/utils/cn'

interface ThreadDividerProps extends HTMLAttributes<HTMLDivElement> {
  /** A solid rule in the border colour, like the completed-turn summary's, instead of the dashed muted one. */
  solid?: boolean
}

/**
 * A rule across the thread with a label in the middle: the compaction
 * boundary, the voice-mode switch, and the fork point are all drawn this way.
 * Callers own the label (an icon and text, or a toggle button).
 */
export function ThreadDivider({ children, className, solid = false, ...rest }: ThreadDividerProps) {
  const rule = cn('flex-1 border-t', solid ? 'border-border' : 'border-dashed border-muted-foreground/30')
  return (
    <div className={cn('flex items-center gap-2 px-4', className)} {...rest}>
      <div className={rule} />
      {children}
      <div className={rule} />
    </div>
  )
}
