import { useEffect, useMemo, useRef } from 'react'

import { cn } from '@shared/lib/utils/cn'

import type { AvatarOrb } from './avatar-orbs'
import {
  blendFrames,
  doneFrame,
  easeInOut,
  idleFrame,
  needsInputFrame,
  restFrame,
  sleepingFrame,
  workingFrame,
  type OrbFrame,
  type OrbState,
} from './orb-states'
import { cubicBezier, FREE_EASE, gazeToward, shapePath, shapePose, type OrbShape, type ShapeGaze } from './orb-shapes'
import { subscribeToFrames } from './orb-ticker'
import { DOTS_CYCLE, DOTS_GATHER, workingPosition } from './orb-working'

/** What the agent is doing, which sets how its avatar moves. */
export type AvatarMotionState = OrbState

// The design's artboard size; every px value below is scaled from it.
const ARTBOARD = 240
// How long a change of state takes to blend, as in the design.
const BLEND_MS = 450
// Following the cursor: free shapes ease quickly; snapping ones keep their own step.
const FOLLOW_MS = 360
// States in which the orb looks at the cursor; the others are busy, asleep or knocking.
const FOLLOWS: readonly OrbState[] = ['idle', 'done']

const prefersReducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
const shortest = (from: number, to: number) => ((((to - from) % 360) + 540) % 360) - 180

/** A still frame for each state, for reduced motion. */
function stillFrame(state: OrbState, restPhi: number): OrbFrame {
  if (state === 'sleeping') return sleepingFrame(0)
  if (state === 'done') return doneFrame(2)
  if (state === 'needs-input') return needsInputFrame(0)
  return restFrame(restPhi)
}

interface Engine {
  state: OrbState
  /** When the current state's own timeline began. */
  since: number
  /** Blending out of this frame since `blendSince`. */
  from: OrbFrame | null
  blendSince: number
  last: OrbFrame
  lastTick: number
  /** The working animation while it runs, and while it plays out after work stops. */
  working: { elapsed: number; position: number; ending: boolean; phi: number } | null
  /** The cursor, while following it. */
  pointer: { x: number; y: number; moved: boolean } | null
  /** Tween toward the latest gaze the cursor asked for. */
  follow: { from: ShapeGaze; to: ShapeGaze; since: number; duration: number; ease: (t: number) => number } | null
}

/**
 * An agent orb in any of the orb shapes, built from the design's layers: the
 * rim-coloured body, the core's glow (a round radial glow on the circle,
 * blurred form-following shading on the other shapes), and the face — a
 * half-size copy of the body that slides toward the edge it looks at.
 *
 * Every state is a frame function of time (orb-states.ts), driven from one
 * shared frame loop and written straight to the layers' styles, so motion
 * costs no React render. Changes of state blend over 0.45s; leaving
 * "working" first plays the dots' gather and regrow. `followPointer` tracks
 * the cursor while idle or done — `true` anywhere, or a selector for an
 * ancestor region — and hands back to the state when it leaves. Reduced
 * motion holds a still frame per state.
 */
export function OrbAvatar({
  orb,
  shape,
  diameter,
  restingPhi,
  state = 'idle',
  followPointer = false,
  className,
}: {
  orb: AvatarOrb
  shape: OrbShape
  diameter: number
  /** Resting gaze direction, degrees (0 = right). */
  restingPhi: number
  state?: AvatarMotionState
  followPointer?: boolean | string
  className?: string
}) {
  const rootRef = useRef<HTMLSpanElement>(null)
  const bodyRef = useRef<HTMLSpanElement>(null)
  const glowRef = useRef<HTMLSpanElement>(null)
  const formWrapRef = useRef<HTMLSpanElement>(null)
  const formRef = useRef<HTMLSpanElement>(null)
  const faceRef = useRef<HTMLSpanElement>(null)
  const lidRef = useRef<HTMLSpanElement>(null)
  const gradientRef = useRef<HTMLSpanElement>(null)
  const highlightRef = useRef<HTMLSpanElement>(null)
  const dotRefs = useRef<(HTMLSpanElement | null)[]>([])

  // Per-agent variety: where idle glances and sleeping breaths start.
  const phase = (((restingPhi % 360) + 360) % 360) / 360 * 5.3
  const reduced = useMemo(prefersReducedMotion, [])
  const scale = diameter / ARTBOARD
  const path = useMemo(() => `path('${shapePath(shape, diameter)}')`, [shape, diameter])
  const dotPaths = useRef(new Map<number, string>())

  const engine = useRef<Engine | null>(null)
  if (!engine.current) {
    const first = reduced ? stillFrame(state, restingPhi) : state === 'working' ? restFrame(restingPhi) : frameFor(state, 0)
    engine.current = {
      state, since: 0, from: null, blendSince: 0, last: first, lastTick: 0, working: null, pointer: null, follow: null,
    }
  }

  function frameFor(current: OrbState, t: number): OrbFrame {
    if (current === 'idle') return idleFrame(t + phase, restingPhi)
    if (current === 'sleeping') return sleepingFrame(t + phase)
    if (current === 'done') return doneFrame(t)
    if (current === 'needs-input') return needsInputFrame(t)
    return restFrame(restingPhi)
  }

  function dotPath(size: number): string {
    const key = Math.round(size * 2) / 2
    let cached = dotPaths.current.get(key)
    if (!cached) {
      cached = `path('${shapePath(shape, key)}')`
      dotPaths.current.set(key, cached)
    }
    return cached
  }

  /** Write a frame to the layers. */
  function paint(frame: OrbFrame) {
    const p = shapePose(shape, frame, diameter, orb.hold)
    const body = bodyRef.current
    if (body) {
      body.style.transform = `translateY(${frame.jump * diameter}px) scale(${frame.scale * frame.scaleX}, ${frame.scale * frame.scaleY})`
      body.style.opacity = String(frame.opacity)
      body.style.filter = frame.saturation < 0.999 ? `saturate(${frame.saturation})` : ''
    }
    if (glowRef.current) {
      glowRef.current.style.opacity = String((p.shaped ? 0.3 : 1) * frame.glowOpacity)
      glowRef.current.style.transform = `translate(${p.glowX}px, ${p.glowY}px) scale(${frame.glow})`
    }
    if (formWrapRef.current) formWrapRef.current.style.opacity = String(frame.glowOpacity)
    if (formRef.current) formRef.current.style.transform = `translate(${p.glowX}px, ${p.glowY}px) scale(${p.formScale * frame.glow})`
    if (faceRef.current) {
      faceRef.current.style.transform = `translate(${p.faceX}px, ${p.faceY}px) rotate(${p.faceTurn}deg) scaleY(${p.squash}) rotate(${-p.faceTurn}deg) scale(${0.5 * frame.faceScale})`
      faceRef.current.style.opacity = String(frame.faceOpacity)
    }
    if (lidRef.current) lidRef.current.style.transform = `scaleY(${frame.blink})`
    if (gradientRef.current) gradientRef.current.style.transform = `rotate(${p.faceTurn}deg)`
    if (highlightRef.current) highlightRef.current.style.transform = `translate(${p.highlightX}px, ${p.highlightY}px) scale(0.62)`
    dotRefs.current.forEach((node, i) => {
      if (!node) return
      const dot = frame.dots[i]
      if (!dot) {
        node.style.display = 'none'
        return
      }
      node.style.display = ''
      node.style.left = `${diameter / 2 + dot.x - dot.size / 2}px`
      node.style.top = `${diameter / 2 + dot.y - dot.size / 2}px`
      node.style.width = node.style.height = `${dot.size}px`
      node.style.opacity = String(dot.opacity)
      node.style.clipPath = dotPath(dot.size)
      node.style.background = `linear-gradient(${p.faceTurn + 135}deg, ${orb.faceA} 20%, ${orb.faceB} 85%)`
    })
  }

  /** The gaze the follow tween shows at `now`. */
  function followGaze(follow: NonNullable<Engine['follow']>, now: number): ShapeGaze {
    const k = follow.ease(Math.min(1, (now - follow.since) / follow.duration))
    return {
      phi: follow.from.phi + shortest(follow.from.phi, follow.to.phi) * k,
      distance: follow.from.distance + (follow.to.distance - follow.from.distance) * k,
    }
  }

  function tick(now: number) {
    const e = engine.current!
    const dt = e.lastTick ? Math.min(now - e.lastTick, 64) : 16
    e.lastTick = now
    let frame: OrbFrame | null = null

    const run = e.working
    if (run) {
      if (run.ending) {
        run.position += dt / 1000
        if (run.position >= DOTS_CYCLE) {
          // Played out: the pending state starts, blending from the regrown orb.
          e.working = null
          e.from = e.last
          e.blendSince = now
          e.since = now
        }
      } else {
        run.elapsed += dt / 1000
        run.position = workingPosition(run.elapsed)
      }
      if (e.working) frame = workingFrame(run.position, diameter, run.phi)
    }
    if (!frame) frame = frameFor(e.state, (now - e.since) / 1000)

    // The cursor steers the gaze while idle or done.
    if (e.pointer && !e.working && FOLLOWS.includes(e.state)) {
      const rect = rootRef.current?.getBoundingClientRect()
      if (e.pointer.moved && rect?.width) {
        e.pointer.moved = false
        const shown = e.follow ? followGaze(e.follow, now) : { phi: frame.phi, distance: frame.distance }
        const target = gazeToward(shape, shown, e.pointer.x - (rect.left + rect.width / 2), e.pointer.y - (rect.top + rect.height / 2), rect.width)
        const changed = !e.follow || Math.abs(shortest(e.follow.to.phi, target.phi)) > 0.5 || Math.abs(e.follow.to.distance - target.distance) > 0.01
        if (changed) {
          e.follow = {
            from: shown,
            to: target,
            since: now,
            duration: shape.snaps ? shape.duration : FOLLOW_MS,
            ease: cubicBezier(shape.snaps ? shape.ease : FREE_EASE),
          }
        }
      }
      if (e.follow) frame = { ...frame, ...followGaze(e.follow, now) }
    }

    if (e.from) {
      const k = (now - e.blendSince) / BLEND_MS
      if (k < 1) frame = blendFrames(e.from, frame, easeInOut(k))
      else e.from = null
    }
    e.last = frame
    paint(frame)
  }

  // The shared frame loop (none under reduced motion).
  useEffect(() => {
    if (reduced) return
    engine.current!.since = performance.now()
    return subscribeToFrames(tick)
    // `tick` reads everything through refs and this render's props.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduced, shape, diameter, orb, restingPhi])

  // A change of state: blend into it, or let the dots play out first.
  useEffect(() => {
    const e = engine.current!
    if (e.state === state && (state !== 'working' || e.working)) return
    const now = performance.now()
    const leaving = e.state
    e.state = state
    if (reduced) {
      paint(stillFrame(state, restingPhi))
      return
    }
    const run = e.working
    if (state === 'working') {
      if (run) {
        // Back to work while finishing: keep typing if the dots are still out, else start over.
        run.ending = false
        run.elapsed = run.position < DOTS_GATHER ? run.position : 0
      } else {
        e.working = { elapsed: 0, position: 0, ending: false, phi: e.last.phi }
        e.from = e.last
        e.blendSince = now
      }
      e.follow = null
      return
    }
    if (leaving === 'working' && run && !run.ending) {
      if (run.position < 0.5) {
        // Stopped before the dots formed: just settle into the new state.
        e.working = null
      } else {
        run.ending = true
        run.position = Math.max(run.position, DOTS_GATHER)
        return
      }
    }
    e.from = e.last
    e.blendSince = now
    e.since = now
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, reduced])

  useEffect(() => {
    if (!followPointer || reduced) return
    // Follow within the nearest ancestor matching the selector, else anywhere.
    const region =
      (typeof followPointer === 'string' && rootRef.current?.closest<HTMLElement>(followPointer)) || null
    const target: HTMLElement | Window = region ?? window
    const leaveFrom = region ?? document.documentElement
    const onMove = (event: Event) => {
      if (!(event instanceof MouseEvent)) return
      engine.current!.pointer = { x: event.clientX, y: event.clientY, moved: true }
    }
    const onLeave = () => {
      const e = engine.current!
      if (!e.pointer) return
      e.pointer = null
      if (e.follow) {
        e.follow = null
        e.from = e.last
        e.blendSince = performance.now()
      }
    }
    target.addEventListener('pointermove', onMove)
    leaveFrom.addEventListener('pointerleave', onLeave)
    return () => {
      target.removeEventListener('pointermove', onMove)
      leaveFrom.removeEventListener('pointerleave', onLeave)
      engine.current!.pointer = null
      engine.current!.follow = null
    }
  }, [followPointer, reduced])

  // First paint from React; every later frame is written by `paint`.
  const first = shapePose(shape, engine.current.last, diameter, orb.hold)
  const f = engine.current.last
  return (
    <span
      ref={rootRef}
      aria-hidden="true"
      data-avatar-orb={orb.name}
      data-avatar-shape={shape.name}
      className={cn('relative block shrink-0', className)}
      style={{ width: diameter, height: diameter }}
    >
      <span
        ref={bodyRef}
        className="absolute inset-0 overflow-hidden"
        style={{
          clipPath: path,
          background: orb.rim,
          isolation: 'isolate',
          transformOrigin: '50% 88%',
          transform: `translateY(${f.jump * diameter}px) scale(${f.scale * f.scaleX}, ${f.scale * f.scaleY})`,
          opacity: f.opacity,
          filter: f.saturation < 0.999 ? `saturate(${f.saturation})` : undefined,
        }}
      >
        <span
          ref={glowRef}
          data-orb-layer="glow"
          className="absolute rounded-full"
          style={{
            left: 6 * scale,
            top: 6 * scale,
            width: 228 * scale,
            height: 228 * scale,
            background: `radial-gradient(circle closest-side, ${orb.core} 0%, ${orb.core} ${orb.hold}%, ${orb.core}00 100%)`,
            opacity: (first.shaped ? 0.3 : 1) * f.glowOpacity,
            transform: `translate(${first.glowX}px, ${first.glowY}px) scale(${f.glow})`,
          }}
        />
        {first.shaped && (
          <span ref={formWrapRef} className="absolute inset-0" style={{ filter: `blur(${20 * scale}px)`, opacity: f.glowOpacity }}>
            <span
              ref={formRef}
              className="absolute inset-0"
              style={{
                clipPath: path,
                background: orb.core,
                transform: `translate(${first.glowX}px, ${first.glowY}px) scale(${first.formScale * f.glow})`,
              }}
            />
          </span>
        )}
        <span
          ref={faceRef}
          data-orb-layer="face"
          className="absolute inset-0"
          style={{
            transform: `translate(${first.faceX}px, ${first.faceY}px) rotate(${first.faceTurn}deg) scaleY(${first.squash}) rotate(${-first.faceTurn}deg) scale(${0.5 * f.faceScale})`,
            opacity: f.faceOpacity,
          }}
        >
          <span ref={lidRef} className="absolute inset-0 overflow-hidden" style={{ clipPath: path, transform: `scaleY(${f.blink})` }}>
            <span
              ref={gradientRef}
              className="absolute"
              style={{
                left: '-25%',
                top: '-25%',
                width: '150%',
                height: '150%',
                background: `linear-gradient(135deg, ${orb.faceA} 25%, ${orb.faceB} 75%)`,
                transform: `rotate(${first.faceTurn}deg)`,
              }}
            />
            {first.shaped && (
              <span className="absolute inset-0" style={{ filter: `blur(${26 * scale}px)` }}>
                <span
                  ref={highlightRef}
                  className="absolute inset-0"
                  style={{
                    clipPath: path,
                    background: orb.faceA,
                    transform: `translate(${first.highlightX}px, ${first.highlightY}px) scale(0.62)`,
                  }}
                />
              </span>
            )}
          </span>
        </span>
      </span>
      {[0, 1, 2].map(i => (
        <span
          key={i}
          ref={node => {
            dotRefs.current[i] = node
          }}
          data-orb-layer="dot"
          className="absolute"
          style={{ display: 'none' }}
        />
      ))}
    </span>
  )
}
