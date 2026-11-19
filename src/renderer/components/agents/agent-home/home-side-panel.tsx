import type { ReactNode } from 'react'
import { cn } from '@shared/lib/utils/cn'
import { useMediaQuery } from '@renderer/hooks/use-media-query'
import './home-side-panel.css'

/** Where the side panel fits beside the page rather than below it (Tailwind's xl). */
export const SIDE_PANEL_BESIDE_PAGE = '(min-width: 1280px)'

/**
 * Agent Home's side panel, the layout Team Brain's home page uses for its
 * settings: the agent's widgets, its sections and the settings behind Show more, each card
 * floating on the page. It is always there: a column at the page's right from
 * xl, and narrower, the same cards following the page's own content.
 *
 * On a new agent's intro it slides in as one piece: from the right beside the page, mirroring the
 * left column, and up from the bottom below it.
 */
export function HomeSidePanel({ children }: { children: ReactNode }) {
  const beside = useMediaQuery(SIDE_PANEL_BESIDE_PAGE)
  return (
    <aside
      aria-label="Agent settings"
      data-testid="agent-home-side-panel"
      className={cn('space-y-3 intro-step', beside ? 'intro-step-side' : 'intro-step-4')}
    >
      {children}
    </aside>
  )
}
