/**
 * Orb body shapes, from the "Shapes — each with its own way of looking"
 * exploration. The face is always a half-size copy of the body; the shape
 * decides how that face may move. Free shapes (circle, arch, bloom) look in
 * any direction; the rest snap their gaze to their corners or axes, each
 * stepping between them with its own easing.
 *
 * Geometry is in unit space, centred, roughly −1…1 on both axes; gaze angles
 * (`phi`) are degrees with 0 = right, 90 = down, as in Math.atan2 on screen.
 */

import type { AgentAvatarShape } from '@shared/lib/types/agent-avatar'

type Point = readonly [number, number]

export type OrbShapeName = AgentAvatarShape

export interface OrbShape {
  name: OrbShapeName
  label: string
  /** Outline, unit space. */
  points: readonly Point[]
  /** Gaze directions it snaps to; absent = free. */
  snaps?: readonly number[]
  /** Pill: snaps direction but slides the face continuously along it. */
  slide?: boolean
  /** How a change of gaze moves: duration (ms) and cubic-bézier control points. */
  duration: number
  ease: readonly [number, number, number, number]
}

export const FREE_EASE = [0.34, 0.7, 0.2, 1] as const

function polar(count: number, fn: (t: number) => Point): Point[] {
  return Array.from({ length: count }, (_, i) => fn((i / count) * Math.PI * 2))
}

function regular(count: number, radius: number, start: number, dy = 0): Point[] {
  return Array.from({ length: count }, (_, i) => {
    const a = ((start + (i * 360) / count) * Math.PI) / 180
    return [radius * Math.cos(a), radius * Math.sin(a) + dy] as const
  })
}

/** A polygon with each corner replaced by a quadratic curve `fraction` of the way along its edges. */
function rounded(vertices: Point[], fraction: number, segments: number): Point[] {
  const out: Point[] = []
  const n = vertices.length
  vertices.forEach((v, i) => {
    const prev = vertices[(i + n - 1) % n]
    const next = vertices[(i + 1) % n]
    const a: Point = [v[0] + (prev[0] - v[0]) * fraction, v[1] + (prev[1] - v[1]) * fraction]
    const b: Point = [v[0] + (next[0] - v[0]) * fraction, v[1] + (next[1] - v[1]) * fraction]
    for (let k = 0; k <= segments; k++) {
      const t = k / segments
      const u = 1 - t
      out.push([u * u * a[0] + 2 * u * t * v[0] + t * t * b[0], u * u * a[1] + 2 * u * t * v[1] + t * t * b[1]])
    }
  })
  return out
}

function arc(cx: number, cy: number, radius: number, from: number, to: number, count: number): Point[] {
  return Array.from({ length: count + 1 }, (_, i) => {
    const a = ((from + ((to - from) * i) / count) * Math.PI) / 180
    return [cx + radius * Math.cos(a), cy + radius * Math.sin(a)] as const
  })
}

const signedPow = (value: number, exponent: number) => Math.sign(value) * Math.abs(value) ** exponent

export const ORB_SHAPES: readonly OrbShape[] = [
  {
    name: 'circle', label: 'Circle', duration: 850, ease: FREE_EASE,
    points: polar(128, t => [0.96 * Math.cos(t), 0.96 * Math.sin(t)]),
  },
  {
    name: 'squircle', label: 'Squircle', duration: 380, ease: [0.5, 1.5, 0.45, 1],
    snaps: [0, 45, 90, 135, 180, 225, 270, 315],
    points: polar(128, t => [0.9 * signedPow(Math.cos(t), 2 / 4.5), 0.9 * signedPow(Math.sin(t), 2 / 4.5)]),
  },
  {
    name: 'triangle', label: 'Triangle', duration: 340, ease: [0.5, 1.6, 0.4, 1],
    snaps: [-90, 30, 150],
    points: rounded(regular(3, 1.14, -90, 0.17), 0.2, 14),
  },
  {
    name: 'diamond', label: 'Diamond', duration: 360, ease: [0.5, 1.5, 0.45, 1],
    snaps: [-90, 0, 90, 180],
    points: rounded(regular(4, 1.0, -90), 0.2, 14),
  },
  {
    name: 'hexagon', label: 'Hexagon', duration: 420, ease: [0.5, 1.4, 0.45, 1],
    snaps: [-90, -30, 30, 90, 150, 210],
    points: rounded(regular(6, 1.0, -90), 0.18, 12),
  },
  {
    name: 'pill', label: 'Pill', duration: 650, ease: [0.45, 0, 0.2, 1],
    snaps: [0, 180], slide: true,
    points: [...arc(0.36, 0, 0.6, -90, 90, 40), ...arc(-0.36, 0, 0.6, 90, 270, 40)],
  },
  {
    name: 'arch', label: 'Arch', duration: 850, ease: FREE_EASE,
    points: [...arc(0, -0.1, 0.82, 180, 360, 48), ...arc(0.62, 0.72, 0.2, 0, 90, 12), ...arc(-0.62, 0.72, 0.2, 90, 180, 12)],
  },
  {
    name: 'bloom', label: 'Bloom', duration: 900, ease: FREE_EASE,
    points: polar(180, t => {
      const r = 0.87 + 0.08 * Math.cos(8 * t)
      return [r * Math.cos(t), r * Math.sin(t)]
    }),
  },
]

export const orbShape = (name: OrbShapeName | undefined): OrbShape =>
  ORB_SHAPES.find(shape => shape.name === name) ?? ORB_SHAPES[0]

/** CSS `path()` data for the outline at `size` px. */
export function shapePath(shape: OrbShape, size: number): string {
  const half = size / 2
  return `M ${shape.points.map(([x, y]) => `${((x + 1) * half).toFixed(2)} ${((y + 1) * half).toFixed(2)}`).join(' L ')} Z`
}

/** How far from the centre, in unit space, the outline lies in direction (fx, fy). */
export function reach(points: readonly Point[], fx: number, fy: number): number {
  let best = 0
  for (let i = 0; i < points.length; i++) {
    const a = points[i]
    const b = points[(i + 1) % points.length]
    const ex = b[0] - a[0]
    const ey = b[1] - a[1]
    const den = fx * ey - fy * ex
    if (Math.abs(den) < 1e-9) continue
    const t = (a[0] * ey - a[1] * ex) / den
    const s = (a[0] * fy - a[1] * fx) / den
    if (t > 0 && s >= 0 && s <= 1 && t > best) best = t
  }
  return best
}

export interface ShapeGaze {
  /** Gaze direction, degrees (0 = right). Accumulates so turns take the short way. */
  phi: number
  /** How far the face sits toward the edge: 0 = facing the viewer, 1 = at the rim. */
  distance: number
}

/** `to` as the nearest equivalent angle to `from`. */
export function nearestAngle(from: number, to: number): number {
  return from + ((((to - from) % 360) + 540) % 360) - 180
}

/**
 * Apply a shape's gaze grammar to a wanted gaze: free shapes take it as is;
 * snapping shapes turn to their nearest snap and either look at the viewer
 * (when the wanted distance is small) or push the face right to the edge;
 * the pill snaps direction but keeps the distance.
 */
export function applyGrammar(shape: OrbShape, current: number, phi: number, distance: number): ShapeGaze {
  const wanted = nearestAngle(current, phi)
  if (!shape.snaps) return { phi: wanted, distance }
  const snapped = shape.snaps.reduce(
    (best, snap) => {
      const delta = ((((snap - wanted) % 360) + 540) % 360) - 180
      return Math.abs(delta) < Math.abs(best) ? delta : best
    },
    Infinity,
  )
  if (shape.slide) return { phi: wanted + snapped, distance }
  if (distance < 0.35) return { phi: current, distance: 0 }
  return { phi: wanted + snapped, distance: 1 }
}

/** Gaze toward a point `dx, dy` px from the centre of a `size` px avatar. */
export function gazeToward(shape: OrbShape, current: ShapeGaze, dx: number, dy: number, size: number): ShapeGaze {
  const phi = (Math.atan2(dy, dx) * 180) / Math.PI
  // The design's rule at its 240px shapes, d = distance / 200, scaled.
  return applyGrammar(shape, current.phi, phi, Math.min(1, Math.hypot(dx, dy) / (size * (200 / 240))))
}

/** Everything the layers need for a gaze, in px for a `size` px avatar. */
export function shapePose(shape: OrbShape, gaze: ShapeGaze, size: number, hold: number) {
  const half = size / 2
  const a = (gaze.phi * Math.PI) / 180
  const fx = Math.cos(a)
  const fy = Math.sin(a)
  const along = 0.5 * reach(shape.points, fx, fy) * 0.97
  const ox = fx * gaze.distance * along
  const oy = fy * gaze.distance * along
  // A negative distance (the face tipped the other way) trails the glow as at rest.
  const k = 0.35 + 0.65 * Math.max(0, Math.min(1, gaze.distance))
  // The circle gets the round radial glow; other shapes, form-following shading.
  const shaped = shape.name !== 'circle'
  return {
    shaped,
    faceX: ox * half,
    faceY: oy * half,
    glowX: 0.26 * k * (-fy - fx) * half,
    glowY: 0.26 * k * (fx - fy) * half,
    highlightX: 0.36 * (fx + fy) * half,
    highlightY: 0.36 * (fy - fx) * half,
    /** Face squash along the gaze axis: shaped faces foreshorten as they reach the edge. */
    squash: shaped ? 1 - 0.14 * Math.min(1, Math.abs(gaze.distance)) : 1,
    faceTurn: gaze.phi + 90,
    formScale: 0.5 + hold * 0.006,
  }
}

/** A CSS-style cubic-bézier easing curve as a function of 0…1. */
export function cubicBezier([x1, y1, x2, y2]: readonly [number, number, number, number]): (t: number) => number {
  const sample = (a: number, b: number, t: number) => 3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3
  return (x: number) => {
    if (x <= 0) return 0
    if (x >= 1) return 1
    // Find t for x by bisection (x(t) is monotonic for 0 ≤ x1, x2 ≤ 1), then read y.
    let low = 0
    let high = 1
    for (let i = 0; i < 24; i++) {
      const mid = (low + high) / 2
      if (sample(x1, x2, mid) < x) low = mid
      else high = mid
    }
    return sample(y1, y2, (low + high) / 2)
  }
}
