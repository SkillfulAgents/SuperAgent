import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
} from 'react'
import { cn } from '@shared/lib/utils/cn'

// A tiny dwell avoids triggering while the pointer merely crosses a row, while
// still making the interaction feel effectively immediate.
export const HOVER_SCROLL_DELAY_MS = 120
export const HOVER_SCROLL_SPEED_PX_PER_SECOND = 32

type HoverScrollStyle = CSSProperties & {
  '--hover-scroll-distance': string
  '--hover-scroll-duration': string
}

type HoverScrollTextProps = HTMLAttributes<HTMLSpanElement> & {
  hoverTarget?: 'self' | 'parent'
}

export function HoverScrollText({
  children,
  className,
  hoverTarget = 'self',
  onMouseEnter,
  onMouseLeave,
  style: styleProp,
  ...props
}: HoverScrollTextProps) {
  const viewportRef = useRef<HTMLSpanElement>(null)
  const contentRef = useRef<HTMLSpanElement>(null)
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isHoveredRef = useRef(false)
  const lastTextRef = useRef<string | null>(null)
  const [scrollDistance, setScrollDistance] = useState(0)
  const [isScrolling, setIsScrolling] = useState(false)
  const [motionAllowed, setMotionAllowed] = useState(() =>
    typeof window === 'undefined'
      ? true
      : !window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )

  const clearHoverTimer = useCallback(() => {
    if (hoverTimerRef.current !== null) {
      clearTimeout(hoverTimerRef.current)
      hoverTimerRef.current = null
    }
  }, [])

  const measureOverflow = useCallback(() => {
    const viewport = viewportRef.current
    const content = contentRef.current
    if (!viewport || !content) return 0

    const distance = Math.max(0, Math.ceil(content.scrollWidth - viewport.clientWidth))
    setScrollDistance(distance)
    if (distance === 0) {
      clearHoverTimer()
      setIsScrolling(false)
    }
    return distance
  }, [clearHoverTimer])

  const stopScrolling = useCallback(() => {
    isHoveredRef.current = false
    clearHoverTimer()
    setIsScrolling(false)
  }, [clearHoverTimer])

  const startScrolling = useCallback(() => {
    isHoveredRef.current = true
    clearHoverTimer()

    const distance = measureOverflow()
    if (!motionAllowed || distance === 0) return

    hoverTimerRef.current = setTimeout(() => {
      hoverTimerRef.current = null
      if (isHoveredRef.current && measureOverflow() > 0) {
        setIsScrolling(true)
      }
    }, HOVER_SCROLL_DELAY_MS)
  }, [clearHoverTimer, measureOverflow, motionAllowed])

  // Reset on the rendered TEXT changing, not on `children` changing identity.
  // A caller that re-renders on a timer (the activity card re-renders every
  // second for its elapsed clock) hands us a brand-new element each time with
  // the same words in it — keying off that identity cancelled the pan
  // mid-flight and parked the row back at the start, which the sidebar never
  // hit because its child is a plain string. Reading the committed text is
  // what both callers actually mean by "new content".
  useLayoutEffect(() => {
    const text = contentRef.current?.textContent ?? ''
    if (lastTextRef.current === text) return
    lastTextRef.current = text
    // Content changed under the pointer: re-measure and re-arm rather than
    // stall, so a label that updates mid-hover keeps panning.
    if (isHoveredRef.current) {
      startScrolling()
      return
    }
    stopScrolling()
    measureOverflow()
  })

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport || typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver(measureOverflow)
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [measureOverflow])

  useEffect(() => {
    const viewport = viewportRef.current
    const target = hoverTarget === 'parent' ? viewport?.parentElement : viewport
    if (!target) return

    target.addEventListener('mouseenter', startScrolling)
    target.addEventListener('mouseleave', stopScrolling)
    return () => {
      target.removeEventListener('mouseenter', startScrolling)
      target.removeEventListener('mouseleave', stopScrolling)
    }
  }, [hoverTarget, startScrolling, stopScrolling])

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
    const handleMotionPreference = () => {
      const isAllowed = !mediaQuery.matches
      setMotionAllowed(isAllowed)
      if (!isAllowed) stopScrolling()
    }

    handleMotionPreference()
    mediaQuery.addEventListener('change', handleMotionPreference)
    return () => mediaQuery.removeEventListener('change', handleMotionPreference)
  }, [stopScrolling])

  useEffect(() => () => clearHoverTimer(), [clearHoverTimer])

  const durationMs = Math.max(
    250,
    Math.round((scrollDistance / HOVER_SCROLL_SPEED_PX_PER_SECOND) * 1_000)
  )
  const style: HoverScrollStyle = {
    ...styleProp,
    '--hover-scroll-distance': `${scrollDistance}px`,
    '--hover-scroll-duration': `${durationMs}ms`,
  }

  return (
    <span
      ref={viewportRef}
      className={cn('hover-scroll-text block min-w-0 overflow-hidden', className)}
      data-overflowing={scrollDistance > 0}
      data-scrolling={isScrolling}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={style}
      {...props}
    >
      <span ref={contentRef} className="hover-scroll-text-content block truncate">
        {children}
      </span>
    </span>
  )
}
