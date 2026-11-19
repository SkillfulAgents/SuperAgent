import { AtSign } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'

export function WorkingDots({ dotClassName = 'bg-green-500' }: { dotClassName?: string } = {}) {
  return (
    <span className="inline-flex items-center gap-0.5 shrink-0" role="img" aria-label="working">
      <span className={`h-[3px] w-[3px] rounded-full animate-dot-wave ${dotClassName}`} />
      <span className={`h-[3px] w-[3px] rounded-full animate-dot-wave [animation-delay:0.15s] ${dotClassName}`} />
      <span className={`h-[3px] w-[3px] rounded-full animate-dot-wave [animation-delay:0.3s] ${dotClassName}`} />
    </span>
  )
}

export function AwaitingDot() {
  // 12px outer wrapper reserves layout room around the 6px dot so the
  // `animate-ping` halo (rendered as a same-sized sibling that scales via transform)
  // isn't clipped by the parent row's `overflow-hidden`.
  return (
    <span className="relative flex items-center justify-center shrink-0 h-3 w-3" role="img" aria-label="needs input">
      <span className="animate-ping absolute inline-flex h-1.5 w-1.5 rounded-full bg-orange-500 opacity-75" />
      <span className="relative inline-flex rounded-full bg-orange-500 h-1.5 w-1.5" />
    </span>
  )
}

/**
 * Something unread: a small blue dot, or, when it tags you, a purple @ badge.
 * The badge is wider than the dot, so slots that hold it are at least 14px.
 */
export function UnreadDot({ mention = false, className }: { mention?: boolean; className?: string } = {}) {
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
  return (
    <span className={cn('h-1.5 w-1.5 rounded-full bg-blue-500 shrink-0', className)} role="img" aria-label="unread notifications" />
  )
}
