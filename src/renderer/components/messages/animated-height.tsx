import { useEffect, useRef, type ReactNode } from 'react'

const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)'
const DURATION_MS = 320

/**
 * A box whose height glides to follow its contents. The composer swaps
 * between its text and voice forms, and between attachment states, by
 * replacing children; measured here, the frame eases from the old height
 * to the new one while the new contents are revealed from the top, instead
 * of the whole column jumping. Honours reduced motion by doing nothing.
 */
export function AnimatedHeight({ children, className }: { children: ReactNode; className?: string }) {
  const outer = useRef<HTMLDivElement>(null)
  const inner = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const frame = outer.current
    const content = inner.current
    if (!frame || !content || typeof ResizeObserver === 'undefined') return
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    let settled = content.offsetHeight
    let release: ReturnType<typeof setTimeout> | undefined
    const observer = new ResizeObserver(() => {
      const next = content.offsetHeight
      if (next === settled) return
      // At rest the frame has already snapped to the new size by the time
      // this fires, so the start is the last settled height; mid-glide it is
      // wherever the frame has got to.
      const from = frame.style.height ? frame.getBoundingClientRect().height : settled
      settled = next
      frame.style.transition = 'none'
      frame.style.height = `${from}px`
      frame.style.overflow = 'hidden'
      void frame.offsetHeight
      frame.style.transition = `height ${DURATION_MS}ms ${EASE}`
      frame.style.height = `${next}px`
      clearTimeout(release)
      release = setTimeout(() => {
        frame.style.height = ''
        frame.style.overflow = ''
        frame.style.transition = ''
      }, DURATION_MS + 20)
    })
    observer.observe(content)
    return () => {
      observer.disconnect()
      clearTimeout(release)
    }
  }, [])

  return (
    <div ref={outer} className={className}>
      <div ref={inner}>{children}</div>
    </div>
  )
}
