import { createRef, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { OrbAppearance } from './avatar-orbs'
import { OrbAnimation } from './orb-animation'
import { createOrbPainter, type OrbLayers } from './orb-painter'
import type { OrbShape } from './orb-shapes'
import type { OrbState } from './orb-states'
import { subscribeToFrames } from './orb-ticker'
import { observeOrbVisibility } from './orb-visibility'

const layer = () => createRef<HTMLSpanElement>()

/** Degrees the face rolls per pixel scrolled. */
const ROLL_DEG_PER_PX = 1

/** The element matching `selector` nearest `from` in the tree: searched for in each ancestor in turn. */
function findNearest(from: Element, selector: string): Element | null {
  for (let el = from.parentElement; el; el = el.parentElement) {
    const hit = el.querySelector(selector)
    if (hit) return hit
  }
  return null
}

/** Owns the animation lifecycle; the component only supplies the static layers. */
export function useOrbAnimation({ orb, shape, diameter, restingPhi, state, followPointer, rollWithScroll }: {
  orb: OrbAppearance
  shape: OrbShape
  diameter: number
  restingPhi: number
  state: OrbState
  followPointer: boolean | string
  rollWithScroll?: string
}): OrbLayers {
  // Intentionally sampled once; live OS preference changes remain a separate follow-up.
  const [reduced] = useState(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false)
  const [layers] = useState<OrbLayers>(() => ({
    root: layer(), body: layer(), glow: layer(), formWrap: layer(), form: layer(),
    face: layer(), lid: layer(), gradient: layer(), highlight: layer(), dots: [layer(), layer(), layer()],
  }))
  const [animation] = useState(() => new OrbAnimation({ shape, diameter, restingPhi, state, reduced }, performance.now()))
  const paint = useMemo(() => createOrbPainter(layers, shape, diameter, orb), [layers, shape, diameter, orb])
  const paintRef = useRef(paint)
  const pointer = useRef<{ x: number; y: number; dirty: boolean } | null>(null)

  useLayoutEffect(() => {
    paintRef.current = paint
    const now = performance.now()
    animation.configure({ shape, diameter, restingPhi, state, reduced }, now)
    if (pointer.current) pointer.current.dirty = true
    paint(reduced ? animation.last : animation.advance(now))
  }, [animation, paint, shape, diameter, restingPhi, state, reduced])

  useEffect(() => {
    const root = layers.root.current
    if (!root || reduced) return
    const region = typeof followPointer === 'string' ? root.closest<HTMLElement>(followPointer) : null
    const target = region ?? window
    const leaveFrom = region ?? document.documentElement
    let stop: (() => void) | undefined

    const onMove = (event: Event) => {
      if (event instanceof MouseEvent) pointer.current = { x: event.clientX, y: event.clientY, dirty: true }
    }
    const onLeave = () => {
      pointer.current = null
      animation.releasePointer(performance.now())
    }
    const invalidateBounds = () => {
      if (pointer.current) pointer.current.dirty = true
    }
    const measure = (now: number) => {
      const cursor = pointer.current
      if (!cursor?.dirty || !animation.canFollow) return
      cursor.dirty = false
      const rect = root.getBoundingClientRect()
      if (rect.width) animation.lookAt(cursor.x - rect.left - rect.width / 2, cursor.y - rect.top - rect.height / 2, rect.width, now)
    }
    const tick = (now: number) => paintRef.current(animation.advance(now))

    // Rolling: the nearest scroller is re-resolved whenever it is replaced
    // (a session switch remounts the transcript under the same avatar).
    let scroller: Element | null = null
    let lastTop = 0
    const onScroll = (event: Event) => {
      if (!rollWithScroll || !(event.target instanceof Element) || !event.target.matches(rollWithScroll)) return
      if (!scroller?.isConnected) {
        scroller = findNearest(root, rollWithScroll)
        lastTop = scroller?.scrollTop ?? 0
      }
      if (event.target !== scroller) return
      const top = scroller.scrollTop
      animation.rollBy((top - lastTop) * ROLL_DEG_PER_PX)
      lastTop = top
    }

    const unobserve = observeOrbVisibility(root, visible => {
      if (!visible) {
        stop?.()
        stop = undefined
        return
      }
      if (stop) return
      animation.resume(performance.now())
      const unsubscribe = subscribeToFrames(tick, followPointer ? measure : undefined)
      if (rollWithScroll) {
        scroller = findNearest(root, rollWithScroll)
        lastTop = scroller?.scrollTop ?? 0
        window.addEventListener('scroll', onScroll, { capture: true, passive: true })
      }
      if (followPointer) {
        target.addEventListener('pointermove', onMove, { passive: true })
        leaveFrom.addEventListener('pointerleave', onLeave)
        window.addEventListener('scroll', invalidateBounds, true)
        window.addEventListener('resize', invalidateBounds)
      }
      stop = () => {
        unsubscribe()
        target.removeEventListener('pointermove', onMove)
        leaveFrom.removeEventListener('pointerleave', onLeave)
        window.removeEventListener('scroll', invalidateBounds, true)
        window.removeEventListener('resize', invalidateBounds)
        window.removeEventListener('scroll', onScroll, true)
        onLeave()
      }
    })
    return () => {
      unobserve()
      stop?.()
    }
  }, [animation, layers, followPointer, rollWithScroll, reduced])

  return layers
}
