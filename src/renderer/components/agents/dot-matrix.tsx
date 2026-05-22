import { cn } from '@shared/lib/utils/cn'

export type DotMatrixPattern = 'sweep' | 'pulse' | 'blink'

interface DotMatrixProps {
  pattern: DotMatrixPattern
  size?: 3 | 5
  cellPx?: number
  dotPx?: number
  /** Tailwind class for dot color (e.g. 'bg-foreground', 'bg-orange-500'). */
  dotClassName?: string
  className?: string
  ariaLabel?: string
}

const ANIM_BY_PATTERN: Record<DotMatrixPattern, string> = {
  sweep: 'animate-dot-matrix-sweep',
  pulse: 'animate-dot-matrix-pulse',
  blink: 'animate-dot-matrix-blink',
}

const PERIOD_BY_PATTERN: Record<DotMatrixPattern, number> = {
  sweep: 1.4,
  pulse: 2.6,
  blink: 1.1,
}

/**
 * Small dot-matrix indicator. CSS-keyframe driven (no JS animation loop) so it's
 * cheap to stamp many instances (sidebar rows etc.).
 *
 * Patterns:
 *   - sweep: diagonal wavefront; per-cell `animation-delay` keyed to (x + y)
 *   - pulse: all cells breathe in sync
 *   - blink: all cells blink in sync (cursor-like)
 */
export function DotMatrix({
  pattern,
  size = 3,
  cellPx = 4,
  dotPx,
  dotClassName = 'bg-foreground',
  className,
  ariaLabel,
}: DotMatrixProps) {
  const actualDotPx = dotPx ?? Math.max(2, Math.round(cellPx * 0.7))
  const total = size * cellPx + (size - 1) * Math.max(0, cellPx - actualDotPx)
  // Use CSS grid for layout; gap = cellPx - dotPx keeps dot density consistent.
  const gapPx = Math.max(0, cellPx - actualDotPx)

  const cells = []
  const animClass = ANIM_BY_PATTERN[pattern]
  const period = PERIOD_BY_PATTERN[pattern]
  const maxDiag = (size - 1) * 2
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let delay = 0
      if (pattern === 'sweep' && maxDiag > 0) {
        delay = -((x + y) / maxDiag) * period * 0.85
      }
      cells.push(
        <span
          key={`${x}-${y}`}
          className={cn(dotClassName, animClass)}
          style={{
            width: actualDotPx,
            height: actualDotPx,
            animationDelay: delay ? `${delay.toFixed(3)}s` : undefined,
          }}
        />
      )
    }
  }

  return (
    <span
      className={cn('inline-grid shrink-0', className)}
      style={{
        gridTemplateColumns: `repeat(${size}, ${actualDotPx}px)`,
        gridTemplateRows: `repeat(${size}, ${actualDotPx}px)`,
        gap: gapPx,
        width: total,
        height: total,
      }}
      role="img"
      aria-label={ariaLabel}
    >
      {cells}
    </span>
  )
}
