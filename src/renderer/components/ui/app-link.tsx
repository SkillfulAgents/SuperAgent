import { Link, type LinkProps } from '@tanstack/react-router'
import { forwardRef, type MouseEventHandler, type ReactNode } from 'react'
import { cn } from '@shared/lib/utils/cn'
import { router } from '@renderer/router'

type AppLinkProps = LinkProps & {
  className?: string
  /** Class applied while the link's target matches the active route (TanStack `activeProps`). */
  activeClassName?: string
  /** Bake in `app-no-drag` for header/breadcrumb links sitting in the drag region. */
  noDrag?: boolean
  children?: ReactNode
  onClick?: MouseEventHandler<HTMLAnchorElement>
  onDoubleClick?: MouseEventHandler<HTMLAnchorElement>
  title?: string
  'aria-label'?: string
  'data-testid'?: string
}

/**
 * The single navigation primitive: a real `<a href>` so
 * middle/modifier clicks open a new tab on the web. Under Electron's `file://`
 * there is no new-tab target, so we cancel the native modified-click path and
 * navigate the singleton router same-window instead (gated on `!__WEB__`, so the
 * web build keeps native new-tab). Active styling is route-driven via
 * `activeProps` — no Selection state, so it survives a cold reload.
 */
export const AppLink = forwardRef<HTMLAnchorElement, AppLinkProps>(
  ({ className, activeClassName, noDrag, onClick, ...props }, ref) => (
    <Link
      ref={ref}
      {...props}
      onClickCapture={(e) => {
        if (!__WEB__ && (e.metaKey || e.ctrlKey || e.shiftKey || (e as { button?: number }).button === 1)) {
          e.preventDefault()
          // Same-window nav using this link's own target props.
          void router.navigate(props as Parameters<typeof router.navigate>[0])
        }
      }}
      onClick={onClick}
      className={cn(noDrag && 'app-no-drag', className)}
      activeProps={activeClassName ? { className: activeClassName } : undefined}
    />
  ),
)
AppLink.displayName = 'AppLink'
