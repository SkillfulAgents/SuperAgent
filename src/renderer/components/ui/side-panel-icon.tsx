import type { CSSProperties, SVGProps } from 'react'
import { cn } from '@shared/lib/utils/cn'

/**
 * A side panel's toggle, drawn on Lucide's grid (24×24, 2px round strokes) and in its panel icons' square window, so it
 * sits with PanelLeft and friends: inside the window a panel floating clear of its edges, as the panels it opens do.
 * Closed, the panel is a thick line against the window's right edge; open, it widens to the left into a panel, easing
 * between the two.
 */
export function SidePanelIcon({ open, className, ...props }: { open: boolean } & SVGProps<SVGSVGElement>) {
  // The panel sits 2px inside the window's stroke on the right, top and bottom, filled; its right edge stays put and
  // opening grows it to the left. Closed it is 1 wide, which with the stroke reads as a 3px line with round ends.
  const x = open ? 11 : 16
  const width = open ? 6 : 1
  // Geometry as CSS too, so it eases where CSS can set an SVG rect's x and width; the attributes stand in where it can't.
  const panel = { x, width } as CSSProperties
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={24}
      height={24}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cn('lucide', className)}
      data-state={open ? 'open' : 'closed'}
      {...props}
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <rect
        x={x}
        y="7"
        width={width}
        height="10"
        rx="0.5"
        fill="currentColor"
        style={panel}
        // Grows and shrinks on a panel's slide curves (globals.css), so the button and the panel it opens move as one.
        className="side-panel-icon-panel"
      />
    </svg>
  )
}
