import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { ArrowRight, Check, Loader2 } from 'lucide-react'
import { cn } from '@shared/lib/utils'
import { animateSpring, type SpringConfig, type SpringHandle } from '@renderer/lib/spring'
import './slide-to-confirm.css'

/* ══ Slide to confirm ═════════════════════════════════════
   Bencho's "Slide to confirm" (bencho.dev, MIT — bencho.dev/licence),
   rebuilt here without its framer-motion dependency. The motion values
   became refs, the chain of useTransforms became one paint() that writes
   every derived style off x, the springs run on @renderer/lib/spring, and
   the two keyframe tweens are a Web Animations call and a CSS transition.
   The geometry, the numbers and the reasoning are Bencho's, kept as
   written; where the mechanism changed, the comment says so.

   A handle you push across a track. It follows the finger exactly, and
   past the mark it takes over and finishes the journey itself.

   THE HANDLE BECOMES THE ANSWER. On commit it does not hand over to a
   tick somewhere else — it unfurls leftward and fills the track it was
   crossing, and the arrow it was carrying becomes a check. One object
   changing shape, which is the case a morph is actually for, and the
   reason this needs no second element to say "done".

   The right edge does not move while that happens: the width grows by
   exactly what the offset loses. So the handle arrives, plants itself,
   and opens out behind it. */

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

const SPAN = 280
const H = 56
/* the inset the handle keeps from the track, all four sides */
const PAD = 4
/* the handle is a circle in a 56 track, so it is sized by the HEIGHT and
   the width knob does not touch it. Widening the track buys travel, not a
   longer handle — the thing you push stays the thing you push. */
const GRIP = H - PAD * 2
/* the shortest track worth drawing. Below this the centred label starts
   to sit under the resting handle, which is the one collision this layout
   has. */
const MIN = 220
const MAX = 380

/* a pill, and the top of the Corner knob */
const CORNER = H / 2
const SPEED = 50

/* ── how far the swell is, and it is TINY ──────────────────
   The dot sits four pixels inside the track, so the ring round it is the
   whole budget for a hover. 3% of 48 is 1.4, which is 0.7 a side and
   leaves 3.3. */
const SWELL = 1.03

/* ── the settle, as keyframes ─────────────────────────────
   The unfurl ends with the handle exactly filling the track and nothing
   else happening, which reads as the animation stopping rather than as
   the thing landing. A dip of about three per cent and back gives it
   somewhere to arrive.

   On the TRACK, so the whole block gives at once — the handle is the
   track by then, and scaling the two separately would be two objects
   where there is one. A scale drags the corner radius with it, which at
   2.6% is under a pixel on a 28px corner and nobody reads a pulse as a
   change of shape.

   Its own clock rather than the spring's. The spring is nearly there for
   most of its run, so a dip read off it would spike in the first two
   frames and be flat for the rest. And the peak sits late, at 0.62, so
   the block gathers as it lands instead of pulsing before it. A beat
   behind the unfurl (the delay), so it is the landing that dips rather
   than the take-off. */
const PULSE: Keyframe[] = [
  { transform: 'scale(1)' },
  { transform: 'scale(0.974)', offset: 0.62 },
  { transform: 'scale(1)' },
]
const PULSE_TIMING: KeyframeAnimationOptions = {
  duration: 420,
  delay: 100,
  easing: 'cubic-bezier(0.33, 0.55, 0.2, 1)',
}

/* the reset is the anchor coming home: see `reset` */
const RESET: SpringConfig = { stiffness: 380, damping: 34, mass: 0.9 }

/* a release this long after the last move is a handle at rest, and it
   lets go with no speed */
const STILL_MS = 80
/* px/s. Event timing jitters, and one 1ms frame with a 10px move would
   otherwise read as 10,000px/s. */
const MAX_FLING = 4000

const reducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true

export interface SlideToConfirmProps {
  /** What the track says before the slide. Also the handle's accessible name. */
  label?: string
  /** What the handle says once it has unfurled. */
  confirmedLabel?: string
  /**
   * Fires when the handle reaches the end of the track. A returned promise
   * keeps the handle busy (a spinner in place of the check) until it
   * settles; a rejection plays the unfurl backwards so the person can try
   * again. The caller reports the failure — this only re-arms.
   */
  onConfirm: () => void | Promise<unknown>
  /** `destructive` paints the handle in the destructive colour, for deletes. */
  tone?: 'default' | 'destructive'
  /* the track's corner, px. The handle's is this less the inset, which is
     the concentric rule every nested pair follows. */
  corner?: number
  /* how quickly it takes over once you let go, 0..100 */
  speed?: number
  /* the track's length, px. Everything that reads as distance in this
     component — the mark, the label's fade, the arrow's — is a fraction of
     the travel rather than a fixed number of pixels, so all of it follows
     this. */
  width?: number
  className?: string
  /** Goes on the handle, the thing a test drags; the track gets `<id>-track`. */
  'data-testid'?: string
}

export function SlideToConfirm({
  label = 'Slide to confirm',
  confirmedLabel = 'Confirmed',
  onConfirm,
  tone = 'default',
  corner = CORNER,
  speed = SPEED,
  width = SPAN,
  className,
  'data-testid': testId,
}: SlideToConfirmProps) {
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)
  const [held, setHeld] = useState(false)
  const [hot, setHot] = useState(false)
  const track = useRef<HTMLDivElement | null>(null)
  const gripEl = useRef<HTMLButtonElement | null>(null)
  const washEl = useRef<HTMLElement | null>(null)
  const sayEl = useRef<HTMLSpanElement | null>(null)
  const arrowEl = useRef<HTMLSpanElement | null>(null)
  /* the live grab. A ref rather than state for the reason every drag uses
     one: it changes on every frame of a gesture, which is exactly the
     value that must not render. `at`/`t`/`v` are the last move's position,
     time and the speed between it and the one before — see `move`. */
  const grip = useRef<{ id: number; grab: number | null; moved: boolean; t: number; v: number } | null>(null)

  /* ── x and the anchor are REFS, not motion values ────────
     framer-motion's MotionValue is a number that notifies subscribers; a
     ref is a number that does not, and `paint` below is the one
     subscriber there was. Nothing here renders when x moves. */
  const x = useRef(0)
  /* ── where the handle planted itself ─────────────────────
     Zero except while it is unfurling, and then it is the offset the
     handle had when it committed. The width is `GRIP + (anchor - x)`, so
     PAD + x + width comes to PAD + GRIP + anchor — a number with no x in
     it. The right edge is therefore stationary BY ARITHMETIC rather than
     by two animations agreeing.

     It was two: `x` on one spring and `width` on another with the same
     numbers, which is not the same thing at all. They start a frame apart
     and drift, and the right edge measured 6.8px of wobble across the
     morph. One value read twice cannot do that. */
  const anchor = useRef(0)
  /* whether the hover swell applies; a ref so `paint` can read it from a
     spring callback without a stale closure */
  const swell = useRef(false)
  /* everything that must be torn down: the window listeners of a drag in
     progress and the springs in flight. One object, never reassigned, so
     the unmount cleanup can hold it without the exhaustive-deps lint
     reading a ref in a cleanup. */
  const flight = useRef<{ loose: (() => void) | null; x: SpringHandle | null; anchor: SpringHandle | null }>({
    loose: null,
    x: null,
    anchor: null,
  })
  const alive = useRef(true)
  /* the handlers are rebuilt every render and the listeners are not, so
     they are reached through a ref rather than captured — live rather
     than one render stale */
  const live = useRef<{ move: (e: PointerEvent) => void; up: (e: PointerEvent) => void }>({
    move: () => {},
    up: () => {},
  })
  const paintRef = useRef<() => void>(() => {})

  /* ── the width is READ EVERY RENDER, not captured ────────
     `paint` closes over this render's TRAVEL, and the layout effect below
     repaints when it changes — so moving this knob re-derives the mark,
     the fade and the wash on the same frame the number changes. */
  const span = clamp(Math.round(width), MIN, MAX)
  const TRAVEL = span - PAD * 2 - GRIP

  const r = clamp(corner, 0, CORNER)
  /* ── the handle's corner is DERIVED ──────────────────────
     `r - PAD`, floored at zero: the radius of a thing inside another, less
     the gap between them, is what keeps the two curves parallel. At r = 0
     both are square together rather than a square track holding a rounded
     handle. */
  const gripR = Math.max(0, r - PAD)
  /* ── the end IS the commit, and there is no knob ─────────
     There was a Commit dial, 40..100, and it had no meaning to set: a
     slide-to-confirm that fires at 60% is one you can trigger by knocking
     the handle, which is the single thing the gesture exists to prevent.
     The only honest answer is the end of the track, so the end is what it
     is. */
  const mark = TRAVEL

  /* ── SPEED, and deliberately not Bounce ──────────────────
     There was a Bounce knob and it had to go: this shape has a hard wall
     at both ends. On commit the handle exactly fills the track, so there
     is nowhere for an overshoot to go — and because the right edge is
     pinned by the arithmetic above, the overshoot came out of the LEFT
     edge instead. Measured at Bounce 50: the handle shot 42px out of its
     own track.

     A dial whose every setting above zero breaks the component is not a
     dial. Speed is the real question here — how fast it takes over once
     you let go — and the damping is derived to sit exactly on critical,
     so nothing overshoots at any setting of it.

     zeta = c / (2 * sqrt(k * m)), so c at zeta 1 is 2 * sqrt(k * m).
     Written that way the knob can move the stiffness freely and the
     spring stays honest. */
  const stiff = 260 + (clamp(speed, 0, 100) / 100) * 640
  /* the COMMIT stays exactly on critical. It has a wall at the far end
     and the settle is what gives it a landing. */
  const spring: SpringConfig = { stiffness: stiff, damping: 2 * Math.sqrt(stiff * 0.9), mass: 0.9 }
  /* ── the RETURN is not ───────────────────────────────────
     0.62 of critical, so it arrives with something left over rather than
     stopping dead. The overshoot never shows as movement — `seen` clamps
     the position at the wall — it shows as the squash in `paint`, which
     is the same energy spent somewhere it fits. */
  const home: SpringConfig = { ...spring, damping: 2 * Math.sqrt(stiff * 0.9) * 0.62 }

  /* ── everything else is read off x ───────────────────────
     The wash behind the handle, the label giving up its ink, and the
     arrow fading as the end approaches are three readings of one number
     rather than three things animated toward the same moment. This is
     the one place they are read, and it writes straight to the DOM.

     ── and the readings clamp ──────────────────────────────
     The spring is critically damped so x should never go below zero, but
     a handle that can paint outside its own groove is one line away from
     doing it again the next time somebody touches these numbers. `seen`
     is what the transform uses; `x` stays the honest value the drag
     wrote. */
  const paint = () => {
    const g = gripEl.current
    const w = washEl.current
    const s = sayEl.current
    const a = arrowEl.current
    if (!g || !w || !s || !a) return
    const v = x.current
    const seen = clamp(v, 0, TRAVEL)
    /* ── the morph, and it is ONE number ───────────────────
       The width is not being animated at all — it is arithmetic on the
       value the spring is already moving. A scale would have dragged the
       corner radius with it, which is the one thing this shape cannot
       afford. */
    const wide = GRIP + clamp(anchor.current - seen, 0, TRAVEL)
    /* ── the overshoot becomes a SQUASH ────────────────────
       The return spring is under-damped, so it wants to carry past zero —
       and it cannot: at zero the handle is already against the end of its
       track, and four pixels of inset is not room to bounce in. Letting
       it through was measured at 42px outside the block.

       So the position clamps and the energy that would have carried it
       past turns into compression instead. That is what a bounce off a
       wall IS, and it reads as a soft landing rather than a stop. `over`
       is the part of the spring that went past; the two scales are read
       off it, and they multiply so area is kept.

       8%, and the cap is the number that matters rather than the divisor:
       the return overshoots by about 18 units, so any real landing
       reaches the ceiling and the ceiling IS the squash. 14 was measured
       first and reads as a squish; 8 is a give.

       Origin at the LEFT edge (in the CSS), because that is the wall it
       hit. */
    const over = Math.max(0, -v)
    const squash = 1 - Math.min(0.08, over / 110)
    /* both scales ride the same product — the swell has to be multiplied
       INTO the transform rather than set as its own property, which would
       apply first and move the handle along the track it is sitting on */
    const k = swell.current ? SWELL : 1
    g.style.transform = `translateX(${seen}px) scale(${squash * k}, ${(1 / squash) * k})`
    g.style.width = `${wide}px`
    w.style.width = `${seen + GRIP}px`
    s.style.opacity = String(clamp(1 - seen / (TRAVEL * 0.55), 0, 1))
    /* the arrow's fade along the track. Its fade on the COMMIT is the
       `.sld-arrow-ink` transition in the CSS, switched by data-done: read
       off x alone this faded back IN during the unfurl, since committing
       sends x home to zero. The two opacities nest, so they multiply. */
    a.style.opacity = String(clamp(1 - (seen - TRAVEL * 0.55) / (TRAVEL * 0.4), 0, 1))
  }
  paintRef.current = paint

  /* the swell, and a repaint whenever the geometry or the hover changes */
  const swelling = hot && !held && !done
  useLayoutEffect(() => {
    swell.current = swelling
    paintRef.current()
  }, [swelling, TRAVEL])

  useEffect(() => {
    alive.current = true
    const f = flight.current
    return () => {
      alive.current = false
      f.loose?.()
      f.x?.cancel()
      f.anchor?.cancel()
    }
  }, [])

  /* a spring on x or the anchor, or a jump when the person asked for no
     motion. Either way `paint` sees every value. */
  const fly = (which: 'x' | 'anchor', to: number, config: SpringConfig, velocity = 0) => {
    const ref = which === 'x' ? x : anchor
    flight.current[which]?.cancel()
    if (reducedMotion()) {
      ref.current = to
      paintRef.current()
      flight.current[which] = null
      return
    }
    flight.current[which] = animateSpring({
      from: ref.current,
      to,
      velocity,
      config,
      onUpdate: (v) => {
        ref.current = v
        paintRef.current()
      },
      onComplete: () => {
        flight.current[which] = null
      },
    })
  }

  /* ── THE DRAG IS FOLLOWED ON THE WINDOW ──────────────────
     It used to be followed on the track, with pointer capture to keep the
     events coming once the cursor left it. That is the textbook
     arrangement and it has one failure the textbook does not mention:
     capture is best-effort. The call is wrapped in a try/catch here — it
     throws on a synthetic pointer id — and a browser can also drop it
     mid-gesture, on its own, when a touch turns into a system gesture or
     the pointer leaves the window. When that happened the release landed
     on some other element, the track never heard it, and the handle sat
     held at the far end forever.

     Listening on the window removes the dependency. The events reach it
     whatever they are retargeted to and whether or not the capture
     survived, so a release ANYWHERE ends the drag — which is what a
     slider promises: your finger owns the handle until you lift it, not
     until you wander off the track. Capture stays on because it still
     suppresses text selection and the grip's own hover, but nothing
     depends on it any more.

     ── AND IT IS BOUND AT THE PRESS, NOT IN AN EFFECT ───────
     The first version bound them from a `useEffect` on `held`, which is
     the tidier-looking arrangement and drops moves: an effect does not
     run until React has committed the render, and a fast flick can put
     its first pointermove in that gap. That first move is the one that
     sets the grab offset, so losing it means the whole drag does nothing.
     Bound inside `down`, they are live on the same tick as the press. */
  const watch = () => {
    flight.current.loose?.()
    const onMove = (e: PointerEvent) => live.current.move(e)
    const onUp = (e: PointerEvent) => {
      live.current.up(e)
      flight.current.loose?.()
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    flight.current.loose = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      flight.current.loose = null
    }
  }

  const local = (clientX: number) => {
    const box = track.current?.getBoundingClientRect()
    if (!box) return 0
    /* the block may be drawn at a fraction of its own size (a scaled
       dialog mid-entrance), so a pointer delta in screen pixels is not a
       delta in the component's own. The rect's width against the width
       it is laid out at IS that scale, and dividing by it puts the finger
       back into the coordinates the geometry above is written in. */
    const k = box.width / span
    return (clientX - box.left) / (k || 1)
  }

  /* ── the way back, for a confirm that failed ─────────────
     Bencho's demo reset itself on a timer because its wall keeps one
     instance for the session. A confirmation has no such need: once it
     has fired, it has fired, and the parent decides what happens next.
     The only way back is the promise rejecting — the unfurl played
     backwards, which is what it should look like: the anchor comes home
     with x already at zero, so the width shrinks from the full track back
     to the handle and the RIGHT edge sweeps left to the start. */
  const reset = () => {
    setDone(false)
    fly('anchor', 0, RESET)
  }

  const finish = () => {
    setDone(true)
    /* ── x goes to ZERO, and that is the whole morph ────────
       The handle is placed by `x` and sized by `width`, and on commit
       they move by the same amount in opposite directions: x loses
       TRAVEL, width gains it. Their sum is the right edge, so the right
       edge does not move — the handle plants itself where it arrived and
       opens out behind it.

       Sending x to TRAVEL instead was the first version and it is worth
       recording, because it looked plausible in the comment and was
       measurably wrong: the handle stayed at the end AND grew to the full
       width, so its right edge came out at 675 against a 375px track and
       the block spilled over its own frame. */
    anchor.current = x.current
    fly('x', 0, spring)
    if (!reducedMotion()) track.current?.animate?.(PULSE, PULSE_TIMING)

    const outcome = onConfirm()
    if (outcome instanceof Promise) {
      setBusy(true)
      void outcome.then(
        () => {
          if (alive.current) setBusy(false)
        },
        () => {
          if (!alive.current) return
          setBusy(false)
          reset()
        },
      )
    }
  }

  const down = (e: ReactPointerEvent) => {
    if (done) return
    /* the primary button only: a right-click is a context menu, not a
       grab */
    if (e.button !== 0) return
    e.stopPropagation()
    /* ── NO OFFSET YET, it is taken at the first MOVE ───────
       Deciding it here is what made the toggle teleport: a press away
       from the handle would set the offset to the handle's own middle,
       and the first move then jumped it the whole way in one frame. Taken
       at the first move, that move asks for exactly the position the
       handle already has, and every one after it is a delta. */
    grip.current = { id: e.pointerId, grab: null, moved: false, t: 0, v: 0 }
    setHeld(true)
    /* it throws if the id is not a live pointer — a synthetic event from a
       test is exactly that — and the drag works without it, so it must
       not take the grab down with it */
    try {
      track.current?.setPointerCapture(e.pointerId)
    } catch {
      /* not live */
    }
    watch()
  }

  /* both handlers take the NATIVE event as well as React's, because the
     ones that matter arrive from `window`. The two shapes agree on the
     only three fields read here. */
  const move = (e: PointerEvent | ReactPointerEvent) => {
    const g = grip.current
    if (!g || g.id !== e.pointerId) return
    const at = local(e.clientX)
    const now = performance.now()
    if (g.grab === null) {
      g.grab = at - x.current
      g.t = now
      return
    }
    const next = clamp(at - g.grab, 0, TRAVEL)
    if (Math.abs(next - x.current) > 0.5) g.moved = true
    /* ── the release speed is measured here ────────────────
       A motion value carried its own velocity for free; a ref has to be
       told. Units per second over the last two moves, so a flick lets go
       with the speed it had and the return spring starts from it. */
    const dt = (now - g.t) / 1000
    if (dt > 0) g.v = clamp((next - x.current) / dt, -MAX_FLING, MAX_FLING)
    g.t = now
    /* the finger takes over from whatever spring was moving the handle,
       the way setting a motion value stops its animation */
    flight.current.x?.cancel()
    flight.current.x = null
    x.current = next
    paint()
  }

  const up = (e: PointerEvent | ReactPointerEvent) => {
    const g = grip.current
    if (!g) return
    grip.current = null
    /* ── AND THE RELEASE IS GUARDED TOO ────────────────────
       It throws when the pointer was never captured, which the guard
       above makes possible — and unguarded it threw before setHeld(false),
       leaving the handle stuck wherever the drag ended. */
    try {
      track.current?.releasePointerCapture?.(e.pointerId)
    } catch {
      /* never captured */
    }
    setHeld(false)
    if (x.current >= mark) finish()
    else {
      /* a handle that stopped before the release carries no speed into
         the return; one let go mid-flick carries what it had */
      const v = performance.now() - g.t < STILL_MS ? g.v : 0
      fly('x', 0, home, v)
    }
  }

  live.current = { move, up }

  /* ── the keyboard commits in one press ───────────────────
     The gesture exists to stop a stray click, and a keyboard has no
     stray clicks: reaching the handle means tabbing past Cancel to it on
     purpose. Enter or Space there is the slide. */
  const key = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    if (!done) finish()
  }

  return (
    <div className={cn('sld', className)} style={{ width: span, height: H }} data-tone={tone}>
      <div
        className="sld-track"
        ref={track}
        style={{ borderRadius: r }}
        data-testid={testId ? `${testId}-track` : undefined}
        data-held={held || undefined}
        data-done={done || undefined}
        onPointerDown={down}
      >
        {/* the part already crossed. It is not a progress bar — it is the
            ground the handle has covered, which is why it ends AT the
            handle rather than under it */}
        <i ref={washEl} className="sld-wash" aria-hidden="true" style={{ width: GRIP, borderRadius: gripR }} />

        <span ref={sayEl} className="sld-say" aria-hidden="true">
          {label}
        </span>

        <button
          ref={gripEl}
          type="button"
          className="sld-grip"
          data-testid={testId}
          onPointerEnter={() => setHot(true)}
          onPointerLeave={() => setHot(false)}
          onKeyDown={key}
          style={{
            width: GRIP,
            height: GRIP,
            borderRadius: gripR,
            transform: 'translateX(0px) scale(1, 1)',
          }}
          aria-label={done ? confirmedLabel : label}
          aria-busy={busy || undefined}
        >
          <span ref={arrowEl} className="sld-arrow" aria-hidden="true">
            <span className="sld-arrow-ink">
              <ArrowRight size={20} strokeWidth={2} />
            </span>
          </span>

          {/* the word only exists once there is room for it, and it
              arrives with the width rather than after it */}
          <span className="sld-done" aria-hidden="true">
            {busy ? (
              <Loader2 size={20} strokeWidth={2} className="animate-spin" />
            ) : (
              <Check size={20} strokeWidth={2} />
            )}
            {confirmedLabel}
          </span>
        </button>
      </div>
    </div>
  )
}
