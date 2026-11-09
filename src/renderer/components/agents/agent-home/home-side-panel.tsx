import type { CSSProperties, ReactNode } from 'react'
import { cn } from '@shared/lib/utils/cn'

/** Where the side panel fits beside the page rather than below it (Tailwind's xl). */
export const SIDE_PANEL_BESIDE_PAGE = '(min-width: 1280px)'

/** The room the page's column makes for the panel: its 336px plus a 32px gap. */
export const SIDE_PANEL_ROOM = 'xl:pr-[368px]'

interface HomeSidePanelProps {
  /** Beside the page, in its column (sticky; `style` gives where it sticks and its tallest), or below its content. */
  placement: 'beside' | 'below'
  style?: CSSProperties
  children: ReactNode
}

/**
 * Agent Home's side panel, the layout Team Brain's home page uses for its
 * settings: the agent's widgets, its sections and the settings behind Show more, each card
 * floating on the page. It is always there: a column at the page's right from
 * xl, and narrower, the same cards following the page's own content.
 */
export function HomeSidePanel({ placement, style, children }: HomeSidePanelProps) {
  return (
    <aside
      aria-label="Agent settings"
      style={style}
      data-placement={placement}
      className={cn(
        // No surface of its own: its cards (widgets, the sections panel) float on the page, with the Show more toggle below
        // them. Beside the page, a column that scrolls when it is taller than the view.
        placement === 'beside' && 'pointer-events-auto sticky -m-8 flex flex-col overflow-hidden',
      )}
      data-testid="agent-home-side-panel"
    >
      {placement === 'beside' ? (
        // It scrolls when taller than the view, which clips it; the 32px inset (undone by the -m-8 above) puts that
        // clip past the reach of the glass cards' soft shadows, so they are never cut off.
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-8">{children}</div>
      ) : (
        <div className="space-y-3">{children}</div>
      )}
    </aside>
  )
}
