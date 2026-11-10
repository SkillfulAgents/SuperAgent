import type { ReactNode } from 'react'

/** Where the side panel fits beside the page rather than below it (Tailwind's xl). */
export const SIDE_PANEL_BESIDE_PAGE = '(min-width: 1280px)'

interface HomeSidePanelProps {
  /** Beside the page, in a column at its right, or below its content. Either way it scrolls with the page. */
  placement: 'beside' | 'below'
  children: ReactNode
}

/**
 * Agent Home's side panel, the layout Team Brain's home page uses for its
 * settings: the agent's widgets, its sections and the settings behind Show more, each card
 * floating on the page. It is always there: a column at the page's right from
 * xl, and narrower, the same cards following the page's own content.
 */
export function HomeSidePanel({ placement, children }: HomeSidePanelProps) {
  return (
    <aside aria-label="Agent settings" data-placement={placement} data-testid="agent-home-side-panel">
      <div className="space-y-3">{children}</div>
    </aside>
  )
}
