import { Children, type ReactNode } from 'react'
import { cn } from '@shared/lib/utils/cn'

/**
 * A horizontal stack of overlapping icon tiles with an optional trailing overflow chip -
 * the connections-stack treatment. Each child renders inside one tile; the tile chrome,
 * overlap, and stacking order live here so every consumer reads as the same set of chips.
 * Size presets scale the size-bound tokens (tile box, corner radius, overlap) together.
 */
const SIZES = {
  /** Chat-card scale. The radius scales down with the tile: rounded-lg on 18px reads as a circle. */
  xs: { tile: 'h-[18px] w-[18px] rounded-[5px]', chip: 'h-[18px] min-w-[18px] px-1 rounded-[5px]', overlap: -5 },
  // The chip trades the tile's fixed width for min-w so a wide label ('+45') grows instead of
  // clipping; at the label lengths agent home renders ('70+') the box width is unchanged.
  sm: { tile: 'h-8 w-8 rounded-lg', chip: 'h-8 min-w-8 px-1 rounded-lg', overlap: -8 },
  md: { tile: 'h-9 w-9 rounded-lg', chip: 'h-9 min-w-9 px-1 rounded-lg', overlap: -10 },
} as const

const TILE = 'border border-border bg-background dark:bg-zinc-200 flex items-center justify-center shadow-sm'

export function TileStack({
  size = 'sm',
  overflowLabel,
  className,
  children,
}: {
  size?: keyof typeof SIZES
  /** Rendered as a trailing tile-styled chip (e.g. '70+', '+3') when present. */
  overflowLabel?: string
  className?: string
  children: ReactNode
}) {
  const { tile, chip, overlap } = SIZES[size]
  const tiles = Children.toArray(children)
  return (
    <div className={cn('flex items-center', className)} aria-hidden="true">
      {tiles.map((child, i) => (
        <div
          key={i}
          className={cn(tile, TILE, 'transition-transform duration-100 ease-out hover:scale-110 hover:z-10')}
          style={{ marginLeft: i === 0 ? 0 : overlap, zIndex: i }}
        >
          {child}
        </div>
      ))}
      {overflowLabel !== undefined && (
        <div className={cn(chip, TILE)} style={{ marginLeft: overlap, zIndex: tiles.length }}>
          <span className="text-2xs font-medium text-muted-foreground/70 dark:text-zinc-500">
            {overflowLabel}
          </span>
        </div>
      )}
    </div>
  )
}
