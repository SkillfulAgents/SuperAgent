import { becomeTheDots } from './orb-working'

/**
 * The orb's agent states, from the "Final states" exploration — idle,
 * sleeping, done and needs input — plus "become the dots" for working (see
 * orb-working.ts). Each is a pure function of time returning a frame: where
 * the face looks, how the body moves, and how the light behaves. The
 * renderer blends frames when the state changes.
 *
 * Angles are degrees, 0 = right, 90 = down. A negative face distance moves
 * the face the other way along its axis (done's "face tipped up").
 */

export type OrbState = 'idle' | 'working' | 'done' | 'needs-input' | 'sleeping'

export interface OrbFrame {
  phi: number
  /** Face offset toward the edge: 0 = facing the viewer, 1 = at the rim. */
  distance: number
  faceScale: number
  faceOpacity: number
  /** Body: uniform scale, squash and stretch, and jump (× diameter, negative = up). */
  scale: number
  scaleX: number
  scaleY: number
  jump: number
  opacity: number
  /** Face lid: 1 open, 0.1 shut. */
  blink: number
  /** Core light: size multiplier and opacity. */
  glow: number
  glowOpacity: number
  saturation: number
  /** Typing dots, px from the centre (working only). */
  dots: { x: number; y: number; size: number; opacity: number }[]
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x))
const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const segment = (x: number, a: number, b: number) => clamp01((x - a) / (b - a))
const mod = (x: number, m: number) => ((x % m) + m) % m
const bump = (x: number, centre: number, width: number) => Math.max(0, 1 - Math.abs(x - centre) / width)
export const easeInOut = (x: number) => {
  const t = clamp01(x)
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2
}
const blinkAt = (x: number, centre: number) => 1 - 0.9 * bump(x, centre, 0.09)
const shortest = (from: number, to: number) => ((((to - from) % 360) + 540) % 360) - 180

/** Eased keyframes: [time, ...values] rows, holding the ends. */
function keys(x: number, rows: readonly (readonly number[])[]): number[] {
  if (x <= rows[0][0]) return rows[0].slice(1)
  for (let i = 1; i < rows.length; i++) {
    if (x <= rows[i][0]) {
      const a = rows[i - 1]
      const b = rows[i]
      const k = easeInOut((x - a[0]) / (b[0] - a[0]))
      return a.slice(1).map((v, j) => lerp(v, b[j + 1], k))
    }
  }
  return rows[rows.length - 1].slice(1)
}

/** A quick press: up in 0.06s, back over 0.18s. */
function tap(x: number, at: number): number {
  if (x < at) return 0
  if (x < at + 0.06) return (x - at) / 0.06
  if (x < at + 0.24) return 1 - (x - at - 0.06) / 0.18
  return 0
}

export function restFrame(phi: number): OrbFrame {
  return {
    phi, distance: 1, faceScale: 1, faceOpacity: 1, scale: 1, scaleX: 1, scaleY: 1, jump: 0,
    opacity: 1, blink: 1, glow: 1, glowOpacity: 1, saturation: 1, dots: [],
  }
}

// Idle glances, as offsets from the agent's own resting direction.
const GLANCES = [0, 60, -110, 70, -50, 200]

/** Idle: looks somewhere new every 2.2s and blinks now and then. Loops. */
export function idleFrame(t: number, restPhi: number): OrbFrame {
  const frame = restFrame(restPhi)
  const step = Math.floor(t / 2.2)
  const into = mod(t, 2.2)
  const from = GLANCES[mod(step, GLANCES.length)]
  const to = GLANCES[mod(step + 1, GLANCES.length)]
  frame.phi = restPhi + from + shortest(from, to) * easeInOut(segment(into, 1.5, 2.1))
  frame.blink = blinkAt(mod(t, 5.3), 3.1)
  return frame
}

// How much slower a sleeping orb idles.
export const SLEEP_PACE = 2.5

/**
 * Sleeping: idle at a drowsy pace. The same glances and blinks, 2.5× slower,
 * so each look and each blink comes round less often and takes longer. Loops.
 */
export function sleepingFrame(t: number, restPhi: number): OrbFrame {
  return idleFrame(t / SLEEP_PACE, restPhi)
}

/** Done: one slow nod with a swell of light, then rests facing you, face tipped up and a touch brighter. */
export function doneFrame(t: number): OrbFrame {
  const frame = restFrame(90)
  frame.distance =
    t < 0.3
      ? lerp(-0.25, 0.55, easeInOut(segment(t, 0, 0.3)))
      : t < 1.0
        ? keys(t, [[0.3, 0.55], [0.7, -0.35], [1.0, -0.25]])[0]
        : -0.25 + 0.04 * Math.sin((t - 1) * 1.1)
  frame.glow = t < 1.1 ? 1 + 0.2 * bump(t, 0.55, 0.4) + 0.08 * segment(t, 0.5, 1.1) : 1.08
  frame.blink = t < 1.4 ? keys(t, [[0.6, 1], [0.75, 0.45], [1.0, 0.45], [1.3, 1]])[0] : blinkAt(mod(t, 6), 4.5)
  return frame
}

// Hop keyframes: [time, scaleX, scaleY, jump].
const HOP: readonly (readonly number[])[] = [
  [0, 1, 1, 0], [0.18, 1.1, 0.86, 0], [0.3, 0.93, 1.1, -0.08], [0.5, 1, 1, -0.24], [0.68, 0.95, 1.06, 0],
  [0.78, 1.1, 0.87, 0], [0.92, 1, 1, 0], [1.08, 1, 1.02, -0.1], [1.22, 1, 1, 0], [1.3, 1.05, 0.93, 0], [1.45, 1, 1, 0],
]

/** Needs input: two taps toward the screen, then a hop and a smaller hop. Repeats every 3.6s. */
export function needsInputFrame(t: number): OrbFrame {
  const x = mod(t, 3.6)
  const press = tap(x, 0.05) + tap(x, 0.33)
  const [scaleX, scaleY, jump] = keys(x - 0.75, HOP)
  return {
    ...restFrame(-90),
    scaleX,
    scaleY,
    jump,
    scale: 1 + 0.09 * press,
    glow: 1 + 0.3 * press,
    faceScale: 1.1,
    distance: 0.05 + 1.4 * -jump,
    blink: blinkAt(x, 3.1),
  }
}

/** Working: "become the dots", at a cycle position (see orb-working.ts). */
export function workingFrame(position: number, diameter: number, phi: number): OrbFrame {
  const dots = becomeTheDots(position, diameter)
  return {
    ...restFrame(phi),
    distance: dots.distance,
    faceOpacity: dots.faceOpacity,
    scale: dots.scale,
    opacity: dots.opacity,
    blink: dots.blink,
    dots: dots.dots,
  }
}

const NUMERIC = [
  'distance', 'faceScale', 'faceOpacity', 'scale', 'scaleX', 'scaleY', 'jump', 'opacity', 'blink', 'glow',
  'glowOpacity', 'saturation',
] as const

/** Idle poses often hold for many frames; avoid repainting an identical one. */
export function sameFrame(a: OrbFrame, b: OrbFrame): boolean {
  return a.phi === b.phi && NUMERIC.every(key => a[key] === b[key])
    && a.dots.length === b.dots.length && a.dots.every((dot, i) => {
      const other = b.dots[i]
      return dot.x === other.x && dot.y === other.y && dot.size === other.size && dot.opacity === other.opacity
    })
}

/** Ease from one frame to another (k 0…1); the gaze turns the short way, dots belong to the target. */
export function blendFrames(from: OrbFrame, to: OrbFrame, k: number): OrbFrame {
  const frame: OrbFrame = { ...to }
  for (const key of NUMERIC) frame[key] = lerp(from[key], to[key], k)
  frame.phi = from.phi + shortest(from.phi, to.phi) * k
  return frame
}
