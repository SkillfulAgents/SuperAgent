import { Brain } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'

const SIZES = {
  sm: { tile: 'h-8 w-8 rounded-lg', icon: 'h-4 w-4' },
  md: { tile: 'h-10 w-10 rounded-xl', icon: 'h-5 w-5' },
  lg: { tile: 'h-14 w-14 rounded-2xl', icon: 'h-7 w-7' },
} as const

/**
 * Team Brain's mark: the brain glyph on a tile. `solid` is the feature's own
 * colour (foreground on background) for the page and a connected agent;
 * `soft` sits quietly on a muted tile where Team Brain is off or not set up.
 */
export function TeamBrainMark({
  size = 'md',
  tone = 'solid',
  className,
}: {
  size?: keyof typeof SIZES
  tone?: 'solid' | 'soft'
  className?: string
}) {
  const s = SIZES[size]
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex shrink-0 items-center justify-center transition-colors',
        s.tile,
        tone === 'solid' ? 'bg-foreground text-background' : 'bg-muted text-muted-foreground',
        className,
      )}
    >
      <Brain className={s.icon} />
    </span>
  )
}
