import * as React from 'react'
import { MoreVertical } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'

/**
 * Where the menu lands relative to the button.
 *
 * - `below`: top-left corner hangs 4px under the button's left edge — a
 *   dropdown, for a button sitting in a row of a wide list (the agent home).
 * - `beside`: top-left corner sits at the button's bottom-right — the menu
 *   spills out to the right, for a button at the edge of a narrow column (a
 *   sidebar row), where a dropdown would cover the rows beneath it.
 */
export type SessionMenuAnchor = 'below' | 'beside'

export interface SessionMenuButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'children' | 'aria-label' | 'aria-haspopup' | 'aria-expanded'> {
  /**
   * The element the surface's `SessionContextMenu` wraps. A click on this
   * button replays as a `contextmenu` event on it, anchored under the button.
   */
  triggerRef: React.RefObject<HTMLElement | null>
  sessionName: string
  /**
   * Fed from the same `SessionContextMenu`'s `onOpenChange`. Drives `aria-expanded`,
   * and lets a hover-revealed button stay visible while the menu it opened is
   * up (Radix takes pointer events off the page, so `:hover` drops the moment
   * the menu appears).
   */
  menuOpen: boolean
  anchor?: SessionMenuAnchor
  /** Sizing for the icon; the button's own box comes from `className`. */
  iconClassName?: string
}

/**
 * The 3-dot button that opens a session's menu. Every surface that shows one
 * (the sidebar's session rows, the agent home's session list) renders this, so
 * the way the menu is reached can't drift between them.
 *
 * It is deliberately not a menu trigger of its own: the surface already has a
 * `SessionContextMenu` on right-click, and a second Radix menu next to it would
 * be a second list to keep in sync. Instead the click synthesizes the
 * `contextmenu` event the existing trigger listens for — the same trick
 * `ui/context-menu.tsx` uses for its touch long-press — so right-click and the
 * button open one and the same menu.
 *
 * Appearance belongs to the caller (a bare chip in the sidebar, an outline
 * button on the agent home); behaviour and accessibility live here.
 */
export const SessionMenuButton = React.forwardRef<HTMLButtonElement, SessionMenuButtonProps>(
  function SessionMenuButton(
    { triggerRef, sessionName, menuOpen, anchor = 'below', iconClassName, className, ...rest },
    ref
  ) {
    const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
      // The button sits beside a link or inside a clickable row (the sidebar
      // row is an <a>, the list row selects on click); neither the navigation
      // nor the row's own click handler should fire.
      event.preventDefault()
      event.stopPropagation()
      const trigger = triggerRef.current
      if (!trigger) return
      const rect = event.currentTarget.getBoundingClientRect()
      const point =
        anchor === 'beside'
          ? { clientX: rect.right, clientY: rect.bottom }
          : { clientX: rect.left, clientY: rect.bottom + 4 }
      trigger.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, ...point })
      )
    }

    return (
      <button
        ref={ref}
        type="button"
        onClick={handleClick}
        aria-label={`Options for ${sessionName}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        className={cn('inline-flex items-center justify-center', className)}
        {...rest}
      >
        <MoreVertical className={cn('h-4 w-4', iconClassName)} />
      </button>
    )
  }
)
