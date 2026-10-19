import { AtSign } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'

/**
 * Something unread: a small blue dot, or, when it tags you, a purple @ badge.
 * The badge is wider than the dot, so slots that hold it are at least 14px.
 */
export function UnreadDot({ mention = false, className }: { mention?: boolean; className?: string }) {
  if (mention) {
    return (
      <span
        role="img"
        aria-label="mentioned you"
        data-testid="unread-mention"
        className={cn('inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-violet-500 text-white', className)}
      >
        <AtSign className="h-2.5 w-2.5" strokeWidth={3} aria-hidden />
      </span>
    )
  }
  return <span role="img" aria-label="unread notifications" className={cn('h-1.5 w-1.5 shrink-0 rounded-full bg-blue-500', className)} />
}
