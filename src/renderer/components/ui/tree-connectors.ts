/**
 * Tree connectors: the rail-and-elbow treatment that ties a list of sub-items
 * back to the row they hang from — a vertical rail dropping out of the parent
 * row plus a short elbow into each child.
 *
 * Applied to the <ul>; each <li> draws its own connector from two
 * pseudo-elements, so rows of different heights stay connected:
 *
 *   ::before  the elbow — a horizontal hairline into the row, sitting at the
 *             vertical center of the row's FIRST line (rows may wrap or stack
 *             a second line; the elbow stays pinned to the top line).
 *   ::after   the rail — a vertical hairline down the row, stretched upward by
 *             the list's row gap so consecutive segments meet, and stopped at
 *             the elbow on the last row so the tree ends in an L.
 *
 * Geometry is coupled to the layout each list sits in, so it can't be shared as
 * one constant — the rail's x-offset has to land under the parent row's anchor,
 * and the elbow's y-offset is half the child row's height. Tailwind extracts
 * arbitrary values statically, so each variant spells its numbers out literally
 * rather than computing them. The two below are the only call sites; a third
 * belongs here too, next to its neighbours.
 */

/**
 * Sessions/dashboards under an agent in the sidebar (see app-sidebar.tsx).
 *
 * The rail sits 15px from the submenu's left edge (chevron = left-1.5 + p-0.5 +
 * half a 14px icon) and rows are indented pl-5 (20px), so connectors anchor at
 * -5px from each <li>. Elbows sit at 14px = half the h-7 row. Each row's rail
 * segment is stretched -top-1 to bridge the gap-1 between rows; the last row's
 * segment stops at its elbow. The first row instead starts at -top-0.5 so the
 * rail tops out flush with the agent row's bottom edge (the ul's py-0.5) rather
 * than poking 2px up into the agent row's highlight.
 */
export const SIDEBAR_TREE_CONNECTORS =
  '[&>li]:relative ' +
  '[&>li]:before:absolute [&>li]:before:-left-[5px] [&>li]:before:top-[14px] [&>li]:before:w-[5px] ' +
  '[&>li]:before:border-t [&>li]:before:border-muted-foreground/25 ' +
  '[&>li]:after:absolute [&>li]:after:-left-[5px] [&>li]:after:-top-1 [&>li]:after:bottom-0 ' +
  '[&>li]:after:border-l [&>li]:after:border-muted-foreground/25 ' +
  '[&>li:first-child]:after:-top-0.5 ' +
  '[&>li:last-child]:after:bottom-auto [&>li:last-child]:after:h-[18px] ' +
  '[&>li:first-child:last-child]:after:h-[16px]'

/**
 * Subagent rows in the activity indicator card (see agent-activity-indicator.tsx).
 *
 * Same treatment at the card's tighter metrics. The rail hangs from the center
 * of the header's 24px orb: the card pads px-3 (12px) and rows are indented
 * pl-6 (24px), so the orb's center is 12px left of each <li>. The elbow is only
 * 8px of that, so it stops 4px shy of the row — the connector reads as pointing
 * at the row's mark instead of colliding with it. Elbows sit at 8px = half the
 * 16px text row. Every rail segment — including the first — stretches -top-1 to
 * bridge the space-y-1 between rows, which leaves the top of the rail 4px shy
 * of the orb: unlike the sidebar's chevron, the orb has no padding of its own,
 * so a segment run flush to the header would collide with its dots. Last-row
 * segments stop at the elbow (4px overhang + 8px).
 */
export const ACTIVITY_TREE_CONNECTORS =
  '[&>li]:relative ' +
  '[&>li]:before:absolute [&>li]:before:-left-3 [&>li]:before:top-2 [&>li]:before:w-2 ' +
  '[&>li]:before:border-t [&>li]:before:border-muted-foreground/25 ' +
  '[&>li]:after:absolute [&>li]:after:-left-3 [&>li]:after:-top-1 [&>li]:after:bottom-0 ' +
  '[&>li]:after:border-l [&>li]:after:border-muted-foreground/25 ' +
  '[&>li:last-child]:after:bottom-auto [&>li:last-child]:after:h-3'
