import type { ReactNode } from 'react'
import { cn } from '@shared/lib/utils/cn'
import { FLOATING_COMPOSER_CLASS } from '@renderer/components/messages/chat-composer-box'

/**
 * Agent Home's glass: the session composer's material (FLOATING_COMPOSER_CLASS: fill, blur and soft shadow), clearer.
 * Behind it sits the halftone background, which a blur smears into a faint haze that dulls its colour, so a thinner
 * fill lets more of the colour through, and the backdrop is saturated to win back what the haze takes.
 */
const HOME_GLASS = cn(FLOATING_COMPOSER_CLASS, 'supports-[backdrop-filter]:bg-background/[0.58] backdrop-saturate-[1.25]')

/** Agent Home's composer: its glass with no border, like the panels: the shadow and the blur are its edge. */
export const HOME_GLASS_COMPOSER_CLASS = cn(HOME_GLASS, 'border-0')

/**
 * The side panel's glass (its sections and Show more): the composer's material, a little more opaque, since it
 * holds dense rows of settings and floats over the page where it's narrow. No border and no edge highlight: the shadow
 * and the blur are its edge. Each surface adds its own radius.
 */
export const HOME_GLASS_SURFACE_CLASS = cn(HOME_GLASS, 'supports-[backdrop-filter]:bg-background/75')

/**
 * The glass sheet in the main column, as wide as the composer: the composer's own material, so every panel reads as
 * the same glass as the box you type in, with the background passing beneath it.
 */
export const HOME_GLASS_PANEL_CLASS = `w-full rounded-dialog ${HOME_GLASS}`

interface HomeGlassPanelProps {
  /** The panel's label, in the section-label style. */
  title: string
  /** Controls on the label's row, right-aligned (sort, search). */
  actions?: ReactNode
  children: ReactNode
  className?: string
  testId?: string
}

/** A titled glass sheet in Agent Home's main column: Recent sessions, Bookmarks. */
export function HomeGlassPanel({ title, actions, children, className, testId }: HomeGlassPanelProps) {
  return (
    <section className={cn(HOME_GLASS_PANEL_CLASS, 'px-5 pb-4 pt-4', className)} aria-label={title} data-testid={testId}>
      <div className="flex min-h-8 items-center gap-2">
        <h2 className="flex-1 text-[12px]/5 text-muted-foreground">{title}</h2>
        {actions}
      </div>
      <div className="mt-1">{children}</div>
    </section>
  )
}
