import { AtSign } from 'lucide-react'
import { cn } from '@shared/lib/utils'

export function MentionGlyph({ className }: { className?: string } = {}) {
  return (
    <span
      data-testid="mention-glyph"
      className={cn('text-xs font-semibold leading-none text-blue-700 dark:text-blue-400', className)}
      role="img"
      aria-label="mentioned you"
    >
      @
    </span>
  )
}

export function MentionMark({ className }: { className?: string } = {}) {
  return (
    <span
      data-testid="mention-mark"
      className={cn('inline-flex text-blue-700 dark:text-blue-400 shrink-0', className)}
      role="img"
      aria-label="mentioned you"
    >
      <AtSign className="h-3 w-3" strokeWidth={2.25} />
    </span>
  )
}

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

export function UnreadDot() {
  return (
    <span className="h-1.5 w-1.5 rounded-full bg-blue-500 shrink-0" role="img" aria-label="unread notifications" />
  )
}
