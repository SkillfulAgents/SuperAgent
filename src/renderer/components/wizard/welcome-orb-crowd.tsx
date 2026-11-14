import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { cn } from '@shared/lib/utils/cn'
import { AGENT_AVATAR_SHAPES, type AgentAvatarColor } from '@shared/lib/types/agent-avatar'
import { AvatarView, orbRestingPhi } from '@renderer/components/agents/agent-avatar/agent-avatar'
import { avatarSource } from '@renderer/components/agents/agent-avatar/avatar-source'
import { observeOrbVisibility } from '@renderer/components/agents/agent-avatar/orb-visibility'
import { subscribeToAmbientFrames } from '@renderer/lib/ambient-frames'
import { animateSpring, type SpringHandle } from '@renderer/lib/spring'
import { OrbRink, type Point } from './orb-rink'
import { WelcomeDebossedMark } from './welcome-debossed-mark'

/**
 * Starting spots as fractions of the rink, hand-placed so the crowd begins
 * loose rather than gridded. The spots and colours are the iOS welcome
 * screen's, so the two crowds are the same eighteen agents.
 */
const SPOTS: readonly Point[] = [
  [0.08, 0.10], [0.92, 0.12],
  [0.16, 0.30], [0.50, 0.27], [0.84, 0.31],
  [0.32, 0.40], [0.72, 0.43], [0.08, 0.48],
  [0.52, 0.53], [0.90, 0.56], [0.22, 0.61],
  [0.70, 0.66], [0.42, 0.72],
  [0.12, 0.80], [0.88, 0.80], [0.56, 0.88],
  [0.28, 0.95], [0.84, 0.96],
].map(([x, y]) => ({ x, y }))

const COLORS: readonly AgentAvatarColor[] = [
  'tonal-red', 'tonal-blue', 'tonal-amber', 'tonal-teal', 'tonal-purple',
  'tonal-green', 'tonal-pink', 'duo-blue-amber', 'tonal-orange',
  'duo-cobalt-teal', 'tonal-white', 'duo-pink-blue', 'tonal-cobalt', 'duo-red-amber',
  'tonal-blush', 'duo-green-amber', 'duo-teal-blush', 'tonal-forest',
]

const CROWD = SPOTS.map((_spot, index) => ({
  id: index,
  source: avatarSource({
    color: COLORS[index % COLORS.length],
    shape: AGENT_AVATAR_SHAPES[index % AGENT_AVATAR_SHAPES.length],
  }),
  restingPhi: orbRestingPhi(`welcome-${index}`),
}))

/** The share of the rink the orbs cover: the iOS screen's, where 92pt orbs sit on a phone. */
const COVERAGE = 0.34
const MIN_DIAMETER = 48
const MAX_DIAMETER = 140

/** One size for the whole rink, so every collision is a fair one, sized to the panel. */
function orbDiameter(width: number, height: number): number {
  const fitted = 2 * Math.sqrt((COVERAGE * width * height) / (CROWD.length * Math.PI))
  // Whole steps of 4px: a window being dragged wider re-sizes the orbs a few times, not every frame.
  return Math.min(MAX_DIAMETER, Math.max(MIN_DIAMETER, Math.round(fitted / 4) * 4))
}

/** A press that moved less than this is a tap. */
const TAP_SLOP = 10
/** A tapped orb stays lit this long, swelling and brightening on a spring that overshoots a little. */
const LIT_MS = 1800
const LIT_EASE = '450ms cubic-bezier(0.34, 1.56, 0.64, 1)'
const LIT_TRANSITION = `transform ${LIT_EASE}, filter ${LIT_EASE}`
/** A flick's velocity is read over the pointer's last moments, so one jittery sample cannot decide it. */
const FLICK_WINDOW_MS = 100
/** The hop: a kick upward on a spring that lands with a small dip. Up to about a quarter of the orb's height. */
const HOP_SPRING = { stiffness: 320, damping: 18, mass: 1 }
const HOP_KICK = 6
/** How long the panel must hold its size, after a pause, before the rink takes it as the new boards. */
const SETTLE_MS = 150
/** How often a resting pointer is re-announced to the orbs watching it (ms). */
const GAZE_BEAT_MS = 100

const RINK = '[data-orb-rink]'

/**
 * The setup wizard's cover: the iOS welcome screen's crowd of agent orbs,
 * gliding on ice over the debossed Gamut mark. Grab one and flick it across
 * the rink; it slides, caroms off the others and rebounds off the edges,
 * slowing only a little. Press an
 * empty patch and sweep, and the orbs near it scatter; click one and it hops
 * and lights up. Every orb watches the cursor while it is over the rink.
 *
 * The physics is `OrbRink`; the orbs are the app's own agent avatars. Motion
 * is written straight to the orbs' transforms from the app's shared ambient
 * frame loop, so a frame costs no React render. `paused` holds the rink still
 * (the wizard sets it while this panel is slid away); reduced motion gets the
 * crowd at rest in its starting spots.
 *
 * The glide is decoration (docs/animations.md): in a window that is not the
 * one in use the rink holds where it is, and carries on from there. The orbs
 * themselves are avatars and keep their own slow clock.
 */
export function WelcomeOrbCrowd({ paused = false, className }: { paused?: boolean; className?: string }) {
  const rootRef = useRef<HTMLDivElement>(null)
  const orbRefs = useRef<(HTMLDivElement | null)[]>([])
  const hopRefs = useRef<(HTMLDivElement | null)[]>([])
  const [rink] = useState(() => new OrbRink(SPOTS))
  const [diameter, setDiameter] = useState(0)
  const [lit, setLit] = useState<ReadonlySet<number>>(() => new Set())
  // Sampled once, as the avatars do.
  const [still] = useState(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false)

  // Coming back from a pause the panel is still sliding in, growing from
  // nothing. Boards that narrow would crush the crowd into a column, so the
  // rink stays held until the panel's size stops changing.
  const [settling, setSettling] = useState(false)
  const [wasPaused, setWasPaused] = useState(paused)
  if (wasPaused !== paused) {
    setWasPaused(paused)
    if (!paused) setSettling(true)
  }
  const held = paused || settling

  useEffect(() => {
    const root = rootRef.current
    if (!settling || !root) return
    const settle = () => setSettling(false)
    let timer = window.setTimeout(settle, SETTLE_MS)
    const observer = new ResizeObserver(() => {
      window.clearTimeout(timer)
      timer = window.setTimeout(settle, SETTLE_MS)
    })
    observer.observe(root)
    return () => {
      window.clearTimeout(timer)
      observer.disconnect()
    }
  }, [settling])

  const place = useCallback(() => {
    const half = rink.diameter / 2
    orbRefs.current.forEach((element, index) => {
      if (!element) return
      const { x, y } = rink.position(index)
      element.style.transform = `translate3d(${(x - half).toFixed(2)}px, ${(y - half).toFixed(2)}px, 0)`
    })
  }, [rink])

  // The panel is the rink: its size sets the boards and the orbs' size.
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root || held) return
    const measure = () => {
      const { clientWidth: width, clientHeight: height } = root
      // Hidden (below the wizard's two-column breakpoint): keep the last rink.
      if (!width || !height) return
      const next = orbDiameter(width, height)
      rink.resize(width, height, next)
      setDiameter(next)
      place()
    }
    const observer = new ResizeObserver(measure)
    observer.observe(root)
    return () => observer.disconnect()
  }, [rink, place, held])

  // Orbs mount, and change size, a render after the rink does.
  useLayoutEffect(place, [place, diameter])

  const pointer = useRef<{ clientX: number; clientY: number } | null>(null)

  useEffect(() => {
    const root = rootRef.current
    if (!root || still || held) return
    let lastBeat = 0
    const tick = (now: number) => {
      rink.step(now)
      place()
      // The avatars re-aim at the cursor only when it moves, but here they
      // move under a cursor at rest. Repeat its last position to them: the
      // event does not bubble, so only the avatars' own listeners on the rink
      // hear it.
      const cursor = pointer.current
      if (cursor && now - lastBeat > GAZE_BEAT_MS) {
        lastBeat = now
        root.dispatchEvent(new PointerEvent('pointermove', cursor))
      }
    }
    let unsubscribe: (() => void) | undefined
    const unobserve = observeOrbVisibility(root, visible => {
      // 60 a second: a flicked orb crosses the rink fast, and a held one follows the pointer.
      if (visible) unsubscribe ??= subscribeToAmbientFrames(tick, { kind: 'decoration', fps: 60 })
      else {
        unsubscribe?.()
        unsubscribe = undefined
      }
    })
    return () => {
      unobserve()
      unsubscribe?.()
    }
  }, [rink, place, still, held])

  // A press: where it started, and the pointer's recent trail for the flick.
  const press = useRef<{ start: Point; trail: { x: number; y: number; at: number }[] } | null>(null)
  const litTimers = useRef(new Map<number, number>())
  const hops = useRef(new Map<number, SpringHandle>())
  const hopHeights = useRef(new Map<number, number>())

  useEffect(() => {
    const timers = litTimers.current
    const springs = hops.current
    return () => {
      timers.forEach(timer => window.clearTimeout(timer))
      springs.forEach(spring => spring.cancel())
    }
  }, [])

  const local = (event: ReactPointerEvent): Point => {
    const rect = event.currentTarget.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  function hopAndLight(index: number) {
    setLit(current => new Set(current).add(index))
    window.clearTimeout(litTimers.current.get(index))
    litTimers.current.set(index, window.setTimeout(() => {
      litTimers.current.delete(index)
      setLit(current => {
        const next = new Set(current)
        next.delete(index)
        return next
      })
    }, LIT_MS))

    const element = hopRefs.current[index]
    if (!element) return
    // A second click mid-air kicks again from wherever the orb is.
    hops.current.get(index)?.cancel()
    hops.current.set(index, animateSpring({
      from: hopHeights.current.get(index) ?? 0,
      to: 0,
      velocity: -HOP_KICK * rink.diameter,
      config: HOP_SPRING,
      onUpdate: y => {
        hopHeights.current.set(index, y)
        element.style.transform = `translateY(${y.toFixed(2)}px)`
      },
      onComplete: () => hops.current.delete(index),
    }))
  }

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return
    const at = local(event)
    event.currentTarget.setPointerCapture(event.pointerId)
    press.current = { start: at, trail: [{ ...at, at: event.timeStamp }] }
    rink.touch(at.x, at.y, at.x, at.y)
    if (rink.held !== null) event.currentTarget.style.cursor = 'grabbing'
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const at = local(event)
    pointer.current = { clientX: event.clientX, clientY: event.clientY }
    const pressed = press.current
    if (!pressed) {
      event.currentTarget.style.cursor = rink.orbUnder(at.x, at.y) === null ? '' : 'grab'
      return
    }
    rink.touch(at.x, at.y, pressed.start.x, pressed.start.y)
    pressed.trail.push({ ...at, at: event.timeStamp })
    while (pressed.trail.length > 2 && event.timeStamp - pressed.trail[0].at > FLICK_WINDOW_MS) pressed.trail.shift()
  }

  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const pressed = press.current
    if (!pressed) return
    press.current = null
    const at = local(event)
    const { start, trail } = pressed
    const tapped = Math.hypot(at.x - start.x, at.y - start.y) < TAP_SLOP
    if (tapped) {
      const hit = rink.orbUnder(start.x, start.y)
      if (hit !== null) hopAndLight(hit)
    }
    // A pointer that stopped before lifting lets go; it does not throw.
    const first = trail[0]
    const span = (event.timeStamp - first.at) / 1000
    const moving = event.timeStamp - trail[trail.length - 1].at < FLICK_WINDOW_MS
    const flick = !tapped && moving && span > 0
    rink.release(flick ? (at.x - first.x) / span : 0, flick ? (at.y - first.y) / span : 0)
    event.currentTarget.style.cursor = rink.orbUnder(at.x, at.y) === null ? '' : 'grab'
  }

  function onPointerLeave() {
    pointer.current = null
  }

  return (
    <div
      ref={rootRef}
      data-orb-rink=""
      data-testid="wizard-orb-crowd"
      aria-hidden="true"
      className={cn('relative touch-none select-none overflow-hidden bg-black', className)}
      {...(still ? {} : { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp, onPointerLeave })}
    >
      <WelcomeDebossedMark />
      {diameter > 0 && CROWD.map((orb, index) => {
        const isLit = lit.has(index)
        return (
          // Its own layer: eighteen orbs move every frame, and none should repaint to do it.
          <div
            key={orb.id}
            ref={element => { orbRefs.current[index] = element }}
            className="absolute left-0 top-0 will-change-transform"
          >
            <div ref={element => { hopRefs.current[index] = element }}>
              <div
                style={{
                  transition: LIT_TRANSITION,
                  ...(isLit && {
                    transform: 'scale(1.12)',
                    filter: `brightness(1.08) drop-shadow(0 0 ${Math.round(diameter * 0.3)}px rgb(255 255 255 / 0.5))`,
                  }),
                }}
              >
                <AvatarView
                  source={orb.source}
                  restingPhi={orb.restingPhi}
                  size={diameter}
                  state={isLit ? 'working' : 'idle'}
                  followPointer={still ? false : RINK}
                  still={still}
                />
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
