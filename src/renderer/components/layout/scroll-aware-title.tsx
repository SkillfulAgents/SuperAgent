import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from 'react'
import { cn } from '@shared/lib/utils/cn'

interface ScrollAwareTitleContextValue {
  isNavTitleVisible: boolean
  registerPageTitle: (element: HTMLElement) => () => void
}

const ScrollAwareTitleContext = createContext<ScrollAwareTitleContextValue | null>(null)

/**
 * Coordinates a page heading with the matching title in the persistent nav.
 * Page headings register themselves below; the nav title stays hidden while
 * any registered heading is visible and reveals once all of them are clipped.
 */
export function ScrollAwareTitleProvider({ children }: { children: ReactNode }) {
  const nextRegistrationId = useRef(0)
  const [pageTitleVisibility, setPageTitleVisibility] = useState<Map<number, boolean>>(
    () => new Map(),
  )

  const registerPageTitle = useCallback((element: HTMLElement) => {
    const registrationId = nextRegistrationId.current++

    // Headings mount in view in the common case. Register synchronously from a
    // layout effect so the duplicate nav title is removed before first paint;
    // IntersectionObserver corrects this after restored/offscreen mounts.
    setPageTitleVisibility((current) => {
      const next = new Map(current)
      next.set(registrationId, true)
      return next
    })

    const observer =
      typeof IntersectionObserver === 'undefined'
        ? null
        : new IntersectionObserver(
            ([entry]) => {
              if (!entry) return
              setPageTitleVisibility((current) => {
                if (!current.has(registrationId)) return current
                const isVisible = entry.isIntersecting
                if (current.get(registrationId) === isVisible) return current
                const next = new Map(current)
                next.set(registrationId, isVisible)
                return next
              })
            },
            // The viewport root still accounts for clipping by nested scroll
            // containers, so each page can place its heading at any height.
            { threshold: 0 },
          )

    observer?.observe(element)

    return () => {
      observer?.disconnect()
      setPageTitleVisibility((current) => {
        if (!current.has(registrationId)) return current
        const next = new Map(current)
        next.delete(registrationId)
        return next
      })
    }
  }, [])

  const isNavTitleVisible =
    pageTitleVisibility.size === 0 ||
    Array.from(pageTitleVisibility.values()).every((isVisible) => !isVisible)

  const value = useMemo(
    () => ({ isNavTitleVisible, registerPageTitle }),
    [isNavTitleVisible, registerPageTitle],
  )

  return (
    <ScrollAwareTitleContext.Provider value={value}>
      {children}
    </ScrollAwareTitleContext.Provider>
  )
}

/**
 * Marks the real, in-page heading whose visibility controls the nav title.
 * It observes the rendered element rather than a scroll offset, which keeps
 * the behavior correct when pages use different top padding or back buttons.
 */
export function ScrollAwarePageTitle({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  const context = useContext(ScrollAwareTitleContext)
  const registerPageTitle = context?.registerPageTitle
  const titleRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const element = titleRef.current
    if (!element || !registerPageTitle) return
    return registerPageTitle(element)
  }, [registerPageTitle])

  return (
    <div
      ref={titleRef}
      className={className}
      data-scroll-aware-page-title=""
      {...props}
    >
      {children}
    </div>
  )
}

/**
 * Nav-side counterpart to ScrollAwarePageTitle. With no registered page title
 * (for example an agent sub-route), its contents remain visible as normal.
 */
export function ScrollAwareNavTitle({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement>) {
  const context = useContext(ScrollAwareTitleContext)
  const isVisible = context?.isNavTitleVisible ?? true
  const [canAnimate, setCanAnimate] = useState(false)

  // A page title registers from a layout effect on the first commit. Defer the
  // transition class by one frame so that initial deduplication is immediate,
  // while subsequent scroll-driven changes still animate in both directions.
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setCanAnimate(true))
    return () => window.cancelAnimationFrame(frame)
  }, [])

  // React 18's HTML attribute types predate the now-baseline `inert` attribute.
  // An empty boolean attribute keeps hidden nav links out of keyboard focus.
  const inertProps = isVisible ? {} : { inert: '' }

  return (
    <span
      className={cn(
        'inline-flex min-w-0',
        canAnimate &&
          'transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none',
        isVisible
          ? 'translate-y-0 opacity-100'
          : 'pointer-events-none -translate-y-1 opacity-0',
        className,
      )}
      aria-hidden={!isVisible}
      data-scroll-aware-nav-title={isVisible ? 'visible' : 'hidden'}
      {...props}
      {...inertProps}
    >
      {children}
    </span>
  )
}
