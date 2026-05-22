import { cn } from '@shared/lib/utils/cn'

export type DotMatrixPattern = 'sweep' | 'pulse' | 'blink' | 'scatter' | 'march' | 'static'

interface DotMatrixProps {
  pattern: DotMatrixPattern
  size?: 3 | 5
  cellPx?: number
  dotPx?: number
  /** Tailwind class for dot color (e.g. 'bg-foreground', 'bg-orange-500'). */
  dotClassName?: string
  className?: string
  ariaLabel?: string
  /** Multiplies the base animation duration. 2 = half speed; 0.5 = double speed. */
  speedMultiplier?: number
  /** 0..1 — shifts all cells by this fraction of the (scaled) period. */
  phaseOffset?: number
}

const ANIM_BY_PATTERN: Record<DotMatrixPattern, string> = {
  sweep: 'animate-dot-matrix-sweep',
  pulse: 'animate-dot-matrix-pulse',
  blink: 'animate-dot-matrix-blink',
  scatter: 'animate-dot-matrix-scatter',
  march: 'animate-dot-matrix-march',
  static: '',
}

const PERIOD_BY_PATTERN: Record<DotMatrixPattern, number> = {
  sweep: 1.4,
  pulse: 2.6,
  blink: 1.1,
  scatter: 1.6,
  march: 1.0,
  static: 0,
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
  speedMultiplier = 1,
  phaseOffset = 0,
}: DotMatrixProps) {
  const actualDotPx = dotPx ?? Math.max(2, Math.round(cellPx * 0.7))
  // Gap derives from cellPx - dotPx; total is N dots + (N-1) gaps.
  const gapPx = Math.max(0, cellPx - actualDotPx)
  const total = size * actualDotPx + (size - 1) * gapPx

  const cells = []
  const animClass = ANIM_BY_PATTERN[pattern]
  const basePeriod = PERIOD_BY_PATTERN[pattern]
  const effectivePeriod = basePeriod * speedMultiplier
  const maxDiag = (size - 1) * 2
  // Override animation-duration inline so CSS inline beats the Tailwind utility's
  // baked-in duration; only set when we're actually scaling.
  const overrideDuration = speedMultiplier !== 1 && basePeriod > 0
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let delay = 0
      if (pattern === 'sweep' && maxDiag > 0) {
        delay = -((x + y) / maxDiag) * effectivePeriod * 0.85
      } else if (pattern === 'scatter') {
        // Deterministic pseudo-random offset per cell — same hash shape as the
        // design exploration. Spreads flashes across the full period so cells
        // don't sync up into a visible wave.
        const seed = (x * 73 + y * 31) % 100
        delay = -(seed / 100) * effectivePeriod
      } else if (pattern === 'march' && size > 1) {
        // Columns marching upward, with a slight per-column horizontal tilt.
        // Same shape as the original design exploration.
        const raw = ((size - 1 - y) - x * 0.4) / size
        const frac = raw - Math.floor(raw) // wrap into [0, 1)
        delay = -frac * effectivePeriod
      }
      // Apply the whole-matrix phase offset so different instances of the same
      // pattern desync.
      if (phaseOffset !== 0 && effectivePeriod > 0) {
        delay -= phaseOffset * effectivePeriod
      }
      cells.push(
        <span
          key={`${x}-${y}`}
          className={cn(dotClassName, animClass)}
          style={{
            width: actualDotPx,
            height: actualDotPx,
            animationDelay: delay ? `${delay.toFixed(3)}s` : undefined,
            animationDuration: overrideDuration ? `${effectivePeriod.toFixed(3)}s` : undefined,
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
