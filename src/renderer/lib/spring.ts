/**
 * A damped spring, stepped on requestAnimationFrame.
 *
 * The renderer has no animation library. The slide-to-confirm control was the
 * first thing to want a spring, and a dependency for one component was the
 * wrong trade, so this is the whole of it: one number, one target, the
 * stiffness / damping / mass trio every spring library speaks, and a callback
 * per frame. The caller owns what the number means (a translate, a width) and
 * writes it to the DOM itself.
 *
 * Integration is semi-implicit Euler on fixed sub-steps rather than one step
 * per frame. A 240 Hz step keeps the stiffest spring the app asks for
 * (k = 900, m = 0.9, so ω·dt ≈ 0.13) well inside the stable region at any
 * frame rate, and a frame that arrives late (a hidden tab, a stalled main
 * thread) is capped so the spring never takes one enormous step and flies off.
 *
 * Critical damping is c = 2·√(k·m): a spring built with that never crosses its
 * target, one built with less overshoots and rings. Callers derive their
 * damping from that formula so a stiffness knob cannot make them overshoot.
 */
export interface SpringConfig {
  stiffness: number
  damping: number
  mass: number
}

export interface SpringOptions {
  from: number
  to: number
  /** Starting velocity, in units per second. A drag's release speed goes here. */
  velocity?: number
  config: SpringConfig
  onUpdate: (value: number) => void
  onComplete?: () => void
}

export interface SpringHandle {
  /** Stop now, leaving the value wherever the last frame put it. */
  cancel: () => void
}

/* seconds per integration step */
const STEP = 1 / 240
/* the longest span one frame may integrate; anything later is treated as a
   stall and the spring resumes from where it was */
const MAX_FRAME = 0.064
/* at rest: slower than this (units/s) AND closer than this to the target */
const REST_SPEED = 0.1
const REST_DELTA = 0.01

export function animateSpring({ from, to, velocity = 0, config, onUpdate, onComplete }: SpringOptions): SpringHandle {
  const { stiffness: k, damping: c, mass: m } = config
  let x = from
  let v = velocity
  /* time not yet integrated: a frame rarely lands on a step boundary */
  let carry = 0
  let last: number | null = null
  let raf = 0
  let live = true

  const frame = (now: number) => {
    if (!live) return
    const dt = last === null ? 0 : Math.min(MAX_FRAME, (now - last) / 1000)
    last = now
    carry += dt
    while (carry >= STEP) {
      const a = (-k * (x - to) - c * v) / m
      v += a * STEP
      x += v * STEP
      carry -= STEP
    }
    if (Math.abs(v) < REST_SPEED && Math.abs(x - to) < REST_DELTA) {
      live = false
      /* land exactly, so nobody downstream sees 0.004px of handle */
      onUpdate(to)
      onComplete?.()
      return
    }
    onUpdate(x)
    raf = requestAnimationFrame(frame)
  }
  raf = requestAnimationFrame(frame)

  return {
    cancel: () => {
      if (!live) return
      live = false
      cancelAnimationFrame(raf)
    },
  }
}
