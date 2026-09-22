import { useCallback, useEffect, useMemo, useRef } from 'react'
import { MODE_DRAWS, resolvePreset, type OrbState as PackageOrbState } from 'thinking-orbs'

import { useIsDark } from '@renderer/hooks/use-theme'

/**
 * The thought orbs used by the activity indicator (AgentActivityIndicator):
 * per-state canvas animations plus the status-text/orb-state derivation. The
 * orbs render inside the card above the composer.
 */

// ── Shared 3D primitives ─────────────────────────────────────────────────────
// Projection + painter ported from thinking-orbs (MIT, (c) Jakub Antalik): the
// package exports its frame painters but no way to inject a custom one, so our
// own painters below reuse its depth language directly.

interface Dot {
  x: number
  y: number
  z: number
  r: number
  /** Ink value: 0 = darkest ink on paper; mirrored on dark themes. */
  white: number
  a: number
}

type Vec3 = [number, number, number]

/** Spin + tilt + orthographic projection (thinking-orbs makeProj). */
function makeProj(yaw: number, tilt: number, cx: number, cy: number, scale: number) {
  const st = Math.sin(tilt)
  const ct = Math.cos(tilt)
  const sy = Math.sin(yaw)
  const cyw = Math.cos(yaw)
  return (x: number, y: number, z: number): Vec3 => {
    const x1 = x * cyw + z * sy
    const z1 = -x * sy + z * cyw
    const y1 = y * ct - z1 * st
    const z2 = y * st + z1 * ct
    return [cx + x1 * scale, cy - y1 * scale, z2]
  }
}

/** Z-sort far→near, matte grayscale dots; ink mirrored on dark substrates. */
function paint(ctx: CanvasRenderingContext2D, dots: Dot[], dark: boolean, rMin = 0.35): void {
  dots.sort((a, b) => a.z - b.z)
  for (const d of dots) {
    if (d.a < 0.02) continue
    const w = Math.min(1, Math.max(0, d.white))
    const g = Math.round((dark ? 1 - w : w) * 255)
    ctx.fillStyle = `rgba(${g},${g},${g},${d.a})`
    ctx.beginPath()
    ctx.arc(d.x, d.y, Math.max(rMin, d.r), 0, Math.PI * 2)
    ctx.fill()
  }
}

// House tuning on top of the package's 20px inline preset: slightly smaller
// dots, noticeably denser lattices.
const DOT_RADIUS_MUL = 0.85
const DOT_COUNT_MUL = 1.3

/** The package globe preset's radius multiplier at 20px. Our own painters use
    it too so every orb in the set renders an identical dot. */
const GLOBE_RADIUS_MUL = 1.75

/** The dot-tuning baseline: rendered dot size is pinned to the package's 20px
    inline design at EVERY display size — larger orbs gain lattice density
    (pitch-constant, count scales with area) instead of bigger dots. */
const ORB_BASE_SIZE = 20

// Port of the package's scaleCounts/scaleRadii key machinery (thinking-orbs,
// MIT): <ThinkingOrb/> exposes no density/size knobs, so we re-scale the
// resolved preset opts before handing them to the exported frame painters.
// Lattice pairs take √scale per side so total dot count scales linearly; the
// morph-only iconD key is omitted (shaping uses our own 3D painter).
const COUNT_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['latRings', 'lonDensity'],
  ['rings', 'lonDensity'],
  ['lanes', 'segs'],
]
const COUNT_KEYS = ['orbitN', 'ghostN'] as const
const RADIUS_KEYS = ['rBase', 'rDepth', 'rActive', 'rDot', 'ghostR', 'partR', 'partRDepth'] as const

type OrbOpts = ReturnType<typeof resolvePreset>['opts']

function tuneOpts(opts: OrbOpts, size: number): OrbOpts {
  // Bigger canvases keep the SAME rendered dot size and gain density instead:
  // counts scale with area (pitch-constant spacing), and the radius keys are
  // pre-divided by the painter's own radiusScale growth so dots stay at the
  // 20px-preset size.
  const countMul = DOT_COUNT_MUL * (size / ORB_BASE_SIZE) ** 2
  const radiusMul = DOT_RADIUS_MUL * (ORB_BASE_SIZE / size) ** 0.6
  const out: Record<string, number | undefined> = { ...opts }
  const done = new Set<string>()
  const rt = Math.sqrt(countMul)
  for (const [a, b] of COUNT_PAIRS) {
    const va = out[a]
    const vb = out[b]
    if (va != null && vb != null && !done.has(a) && !done.has(b)) {
      out[a] = Math.max(2, Math.round(va * rt))
      out[b] = Math.max(2, Math.round(vb * rt))
      done.add(a)
      done.add(b)
    }
  }
  for (const k of COUNT_KEYS) {
    const v = out[k]
    if (v != null) out[k] = Math.max(1, Math.round(v * countMul))
  }
  for (const k of RADIUS_KEYS) {
    const v = out[k]
    if (v != null) out[k] = v * radiusMul
  }
  // iconD samples a 1-D outline (the morph mode), so its density tracks
  // perimeter — linear in size, not area like the lattice pairs above.
  if (out.iconD != null) {
    out.iconD = Math.max(0.02, out.iconD * DOT_COUNT_MUL * (size / ORB_BASE_SIZE))
  }
  out.rSizeMul = (out.rSizeMul ?? 1) * radiusMul
  return out
}

type OrbDraw = (ctx: CanvasRenderingContext2D, size: number, t: number, dark: boolean) => void

/** Canvas loop mirroring <ThinkingOrb/> (shared wall clock, reduced-motion
    static frame, hidden-tab pause). Painters draw at the NATIVE display size —
    they are size-aware: dot radius pinned to the 20px tuning, density scaling
    with area (see ORB_BASE_SIZE). */
function OrbCanvas({ draw, speed, staticT = 0.6, size }: { draw: OrbDraw; speed: number; staticT?: number; size: number }) {
  const ref = useRef<HTMLCanvasElement | null>(null)
  const dark = useIsDark()

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    canvas.width = Math.round(size * dpr)
    canvas.height = Math.round(size * dpr)
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const frame = (tSec: number) => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, size, size)
      draw(ctx, size, tSec, dark)
    }

    // Reduced motion → one static, deterministic frame (like the package).
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      frame(staticT)
      return
    }

    let raf = 0
    let running = false
    const loop = () => {
      frame((performance.now() / 1000) * speed)
      if (running) raf = requestAnimationFrame(loop)
    }
    const start = () => {
      if (running) return
      running = true
      raf = requestAnimationFrame(loop)
    }
    const stop = () => {
      running = false
      cancelAnimationFrame(raf)
    }
    const onVis = () => (document.visibilityState === 'hidden' ? stop() : start())
    document.addEventListener('visibilitychange', onVis)
    start()
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [draw, speed, staticT, size, dark])

  return (
    <canvas
      ref={ref}
      aria-hidden
      className="shrink-0"
      style={{ width: size, height: size, display: 'block' }}
    />
  )
}

/** Package painters (listening, searching, ...) with the size-aware tuned opts. */
function PackageOrb({ state, size }: { state: PackageOrbState; size: number }) {
  const { mode, speed, opts } = resolvePreset(state, ORB_BASE_SIZE)
  const tuned = useMemo(() => tuneOpts(opts, size), [opts, size])
  const draw = useCallback<OrbDraw>(
    (ctx, s, t, dark) => MODE_DRAWS[mode](ctx, s, t, dark, tuned),
    [mode, tuned]
  )
  return <OrbCanvas draw={draw} speed={speed} size={size} />
}

// ── Solving orb: quarter-turns that always land clean ────────────────────────
// The package's rubik twists slabs of a lat/long lattice — a 90° turn doesn't
// map that lattice onto itself, so completed moves leave the globe scrambled
// until a palindrome replay unwinds them. This painter uses a Rubik-style
// cube-sphere lattice instead (6 faces × 3×3 dots, slab cuts on the cube's
// third-boundaries): every quarter-turn permutes lattice sites exactly, so
// each move ends with the globe as coherent as it started and the twisting
// runs continuously. Motion grammar (ease, cadence, shading) mirrors the
// package's rubik (thinking-orbs, MIT).

/** Slab boundaries in cube space: the face ANGLE range cut in thirds (±15°).
    A turn is an exact permutation as long as the cut falls BETWEEN rows, which
    it always does for any row count — a row sits at 15° only when 6i+3 = 4n,
    odd on the left and even on the right. Slabs may hold unequal row counts;
    that costs nothing, and it frees the row count to be tuned for density. */
const RUBIK_SLAB_T = Math.tan(Math.PI / 12)

/** Rows per face, derived so this orb's dot pitch matches the package globe
    (the searching orb) — the two sit next to each other in the UI and should
    read as one system. The globe spans 180° of latitude in `latRings` steps
    and a cube face spans 90°, so half the ring count is the same angular
    spacing; dot COUNT then lands within ~1% (96 vs 97 at 24px). Tying it to
    the resolved globe preset keeps them matched if the tuning multipliers
    change. */
function solvingRowsFor(size: number): number {
  const latRings = tuneOpts(resolvePreset('searching', ORB_BASE_SIZE).opts, size).latRings ?? 8
  return Math.max(2, Math.round(latRings / 2))
}

/** Cubelet-center grid in CUBE space — slab selection + rotation happen here;
    points are normalized onto the sphere only at draw time. Face coordinates
    are tan-warped (equiangular cubed-sphere): rows sit at uniform ANGLES after
    normalization, so the dot gap across a face edge matches the gap within a
    face — a plain linear grid reads wider at face centers and bunched at the
    edges. The warped coordinate set is still symmetric, so 90° turns keep
    mapping the lattice onto itself. */
function rubikLattice(n: number): Vec3[] {
  const warp = (a: number) => Math.tan(a * (Math.PI / 4))
  const pts: Vec3[] = []
  for (const sign of [1, -1]) {
    for (let axis = 0; axis < 3; axis++) {
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          const u = warp(((i + 0.5) / n) * 2 - 1)
          const v = warp(((j + 0.5) / n) * 2 - 1)
          const p: number[] = [0, 0, 0]
          p[axis] = sign
          p[(axis + 1) % 3] = u
          p[(axis + 2) % 3] = v
          pts.push(p as Vec3)
        }
      }
    }
  }
  return pts
}

// Keyed by display size, not row count: the painter calls this every frame, so
// resolving the preset each time would be wasted work.
const rubikCache = new Map<number, Vec3[]>()
function rubikLatticeFor(size: number): Vec3[] {
  let pts = rubikCache.get(size)
  if (!pts) {
    pts = rubikLattice(solvingRowsFor(size))
    rubikCache.set(size, pts)
  }
  return pts
}

/** Deterministic hash in [0, 1) — thinking-orbs hashD. */
function hashD(a: number, b: number): number {
  const h = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453
  return h - Math.floor(h)
}

const SOLVING_SPEED = 1.5 // a notch under the package rubik tuning (1.95) — calmer twist cadence + spin
const MOVE_SLOT = 0.42 // scaled seconds per quarter-turn (incl. the rest beat)

function drawSegmentedGlobe(ctx: CanvasRenderingContext2D, size: number, t: number, dark: boolean, solve: boolean): void {
  // One move per slot: random axis / slab / direction, eased over 70% of the
  // slot then resting — since every completed turn is a lattice permutation,
  // consecutive moves chain seamlessly from a clean globe. With `solve` off,
  // the slab never engages and only the global spin remains.
  const slot = Math.floor(t / MOVE_SLOT)
  const p = (t - slot * MOVE_SLOT) / MOVE_SLOT
  const cl = Math.min(1, p / 0.7)
  const ep = 1 - (1 - cl) ** 3 // machine ease-out (package rubik)
  const axis = Math.min(2, Math.floor(hashD(slot, 2.3) * 3))
  const slabIdx = Math.min(2, Math.floor(hashD(slot, 5.9) * 3))
  const dir = hashD(slot, 7.7) < 0.5 ? 1 : -1
  const ang = solve ? dir * (Math.PI / 2) * ep : 0
  // An empty [lo, hi) slab keeps every dot out of the "active band" darkening.
  const lo = !solve ? 2 : slabIdx === 0 ? -1.001 : slabIdx === 1 ? -RUBIK_SLAB_T : RUBIK_SLAB_T
  const hi = !solve ? 2 : slabIdx === 0 ? -RUBIK_SLAB_T : slabIdx === 1 ? RUBIK_SLAB_T : 1.001
  const ca = Math.cos(ang)
  const sa = Math.sin(ang)

  const proj = makeProj(t * 0.55, 0.35 + 0.1 * Math.sin(t * 0.9), size / 2, size / 2, (size / 2) * 0.82)
  // rs pinned to the tuning baseline: dots stay the same size at every scale.
  const rs = (ORB_BASE_SIZE / 300) ** 0.6
  // ×1.75 is the GLOBE's preset multiplier, not rubik's ×1.9 — same reasoning
  // as the row count above: this orb and the searching globe should render an
  // identical dot. House ×0.85 on top.
  const rBase = 0.6 * GLOBE_RADIUS_MUL * DOT_RADIUS_MUL
  const rDepth = 1.7 * GLOBE_RADIUS_MUL * DOT_RADIUS_MUL
  const rActive = 0.3 * GLOBE_RADIUS_MUL * DOT_RADIUS_MUL

  const dots: Dot[] = []
  for (const base of rubikLatticeFor(size)) {
    let [x, y, z] = base
    const coord = axis === 0 ? x : axis === 1 ? y : z
    const inActive = coord >= lo && coord < hi
    if (inActive && ang !== 0) {
      if (axis === 0) {
        const y2 = y * ca - z * sa
        z = y * sa + z * ca
        y = y2
      } else if (axis === 1) {
        const x2 = x * ca + z * sa
        z = -x * sa + z * ca
        x = x2
      } else {
        const x2 = x * ca - y * sa
        y = x * sa + y * ca
        x = x2
      }
    }
    const len = Math.hypot(x, y, z)
    const [px, py, zr] = proj(x / len, y / len, z / len)
    const depth = (zr + 1) / 2
    // the band being turned inks a touch darker — the "hand" (package rubik)
    dots.push({
      x: px,
      y: py,
      z: zr,
      r: (rBase + rDepth * depth + (inActive ? rActive : 0)) * rs,
      white: 0.62 - 0.54 * depth - (inActive ? 0.14 : 0),
      a: 1,
    })
  }
  paint(ctx, dots, dark, 0.3)
}

const drawRubikSphere: OrbDraw = (ctx, size, t, dark) => drawSegmentedGlobe(ctx, size, t, dark, true)
const drawSpinningSphere: OrbDraw = (ctx, size, t, dark) => drawSegmentedGlobe(ctx, size, t, dark, false)

/** Solving orb — segmented quarter-turns that always land on a clean globe.
    Static frame lands post-ease (a finished, coherent turn). */
function SolvingOrb({ size }: { size: number }) {
  return <OrbCanvas draw={drawRubikSphere} speed={SOLVING_SPEED} staticT={MOVE_SLOT * 0.85} size={size} />
}

/** The same dotted globe, spin only — for decorative spots (e.g. the publish
    diagram) where the solving motion is too busy. */
function SpinningOrb({ size }: { size: number }) {
  return <OrbCanvas draw={drawSpinningSphere} speed={SOLVING_SPEED} staticT={MOVE_SLOT * 0.85} size={size} />
}

// ── Compacting orb: sphere → cube → squeeze → release ────────────────────────
// The dotted globe morphs into a cube (each dot slides along its own ray to
// the cube surface), the cube's walls press inward, then everything springs
// back out to the full globe — compaction as a motion: gather, box up,
// squeeze, release.

/** The cube is the SOURCE lattice: 6 faces × n×n ordered grid, so the
    boxed-up phase reads as clean rows — projecting the sphere's lat/long
    rings onto the faces instead left the cube looking scattered. Corners sit
    at the sphere's bounding radius, so nothing overflows the canvas. The
    globe is the same lattice normalized onto the unit sphere (cubed-sphere
    grid, like the solving orb) — each dot morphs along its own ray. n scales
    with display size (pitch-constant spacing) while dot size stays pinned. */
const COMPACT_N = 4
const CUBE_HALF = 1 / Math.sqrt(3)

interface CompactLattice {
  cube: Vec3[]
  sphere: Vec3[]
}

function compactLattice(n: number): CompactLattice {
  const cube: Vec3[] = []
  for (const sign of [1, -1]) {
    for (let axis = 0; axis < 3; axis++) {
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          const u = (((i + 0.5) / n) * 2 - 1) * CUBE_HALF
          const v = (((j + 0.5) / n) * 2 - 1) * CUBE_HALF
          const p: number[] = [0, 0, 0]
          p[axis] = sign * CUBE_HALF
          p[(axis + 1) % 3] = u
          p[(axis + 2) % 3] = v
          cube.push(p as Vec3)
        }
      }
    }
  }
  const sphere: Vec3[] = cube.map(([x, y, z]) => {
    const l = Math.hypot(x, y, z)
    return [x / l, y / l, z / l]
  })
  return { cube, sphere }
}

const compactCache = new Map<number, CompactLattice>()
function compactLatticeFor(size: number): CompactLattice {
  const n = COMPACT_N * Math.max(1, Math.round(size / ORB_BASE_SIZE))
  let lattice = compactCache.get(n)
  if (!lattice) {
    lattice = compactLattice(n)
    compactCache.set(n, lattice)
  }
  return lattice
}

// Cycle (scaled seconds): globe hold → morph to cube, rolling straight into
// the walls squeezing inward (slow gather) → tight hold → spring back to the
// globe (the release is deliberately much faster than the squeeze).
const PHASE_SPHERE = 0.6
const PHASE_MORPH = 0.7
const PHASE_CUBE = 0
const PHASE_SQUEEZE = 0.9
const PHASE_TIGHT = 0.2
const PHASE_RESET = 0.3
const COMPACT_CYCLE = PHASE_SPHERE + PHASE_MORPH + PHASE_CUBE + PHASE_SQUEEZE + PHASE_TIGHT + PHASE_RESET
/** Wall-to-wall squeeze factor at maximum compression. */
const SQUEEZE_MIN = 0.45

function smoothE(x: number): number {
  return x * x * (3 - 2 * x)
}

function drawCompactingCube(ctx: CanvasRenderingContext2D, size: number, t: number, dark: boolean): void {
  // Two knobs describe every phase: m blends each dot sphere→cube along its
  // ray, k scales the cube's walls. The reset is m easing back to 0 with the
  // walls still tight — dots fly straight from the squeezed box to the globe.
  const tc = t % COMPACT_CYCLE
  let m = 0
  let k = 1
  let edge = PHASE_SPHERE
  if (tc < edge) {
    // full globe
  } else if (tc < (edge += PHASE_MORPH)) {
    m = smoothE((tc - (edge - PHASE_MORPH)) / PHASE_MORPH)
  } else if (tc < (edge += PHASE_CUBE)) {
    m = 1
  } else if (tc < (edge += PHASE_SQUEEZE)) {
    m = 1
    k = 1 - (1 - SQUEEZE_MIN) * smoothE((tc - (edge - PHASE_SQUEEZE)) / PHASE_SQUEEZE)
  } else if (tc < (edge += PHASE_TIGHT)) {
    m = 1
    k = SQUEEZE_MIN
  } else {
    // Ease-out cubic: the release leaves the box at full speed and settles.
    const x = (tc - edge) / PHASE_RESET
    m = 1 - (1 - (1 - x) ** 3)
    k = SQUEEZE_MIN
  }

  // Rotation carries on through the whole cycle so the box reads as 3D.
  const proj = makeProj(t * 0.5, 0.4 + 0.06 * Math.sin(t * 0.35), size / 2, size / 2, (size / 2) * 0.82)
  // rs pinned to the tuning baseline: dots stay the same size at every scale.
  const rs = (ORB_BASE_SIZE / 300) ** 0.6
  // Package globe radii at the 20px preset, house ×0.85 on top — same dot as
  // the searching and solving orbs.
  const rBase = 0.6 * GLOBE_RADIUS_MUL * DOT_RADIUS_MUL
  const rDepth = 1.7 * GLOBE_RADIUS_MUL * DOT_RADIUS_MUL
  // Dots tighten a touch as the structure compresses.
  const rMul = 0.7 + 0.3 * (1 + (k - 1) * m)

  const { cube, sphere } = compactLatticeFor(size)
  const dots: Dot[] = []
  for (let i = 0; i < sphere.length; i++) {
    const p = sphere[i]
    const c = cube[i]
    const [px, py, z] = proj(
      p[0] + (c[0] * k - p[0]) * m,
      p[1] + (c[1] * k - p[1]) * m,
      p[2] + (c[2] * k - p[2]) * m
    )
    const depth = (z + 1) / 2
    dots.push({
      x: px,
      y: py,
      z,
      r: (rBase + rDepth * depth) * rs * rMul,
      white: 0.62 - 0.54 * depth,
      a: 1,
    })
  }
  paint(ctx, dots, dark, 0.3)
}

/** Compacting orb — the globe boxes itself up, squeezes, and springs back. */
function CompactingOrb({ size = 20 }: { size?: number }) {
  return <OrbCanvas draw={drawCompactingCube} speed={1} staticT={0.3} size={size} />
}

/**
 * What the indicator is showing, in the app's own vocabulary.
 *
 * Deliberately NOT the package's `OrbState`. Two of its members collide with
 * ours in name but not in animation — the package's `solving` is a lat/long
 * rubik that scrambles between moves, and its `shaping` morphs a 2-D outline
 * circle→triangle→square. Neither is what we draw for `working` /
 * `compacting`, so reusing its vocabulary would send the next reader to the
 * package's docs for the wrong picture.
 */
export type ActivityOrbState = 'working' | 'spinning' | 'waiting' | 'retrying' | 'compacting'

/** Thought-orb activity dot (thinking-orbs painters, house-tuned density/size).
    The animation itself is the state cue. Each arm below names its painter
    explicitly — the two package states are the ONLY place the package's
    vocabulary appears. */
export function ActivityOrb({ state = 'working', size = 20 }: { state?: ActivityOrbState; size?: number }) {
  switch (state) {
    // Our own painters — see the section comments above each for why the
    // package's same-named states don't fit.
    case 'working':
      return <SolvingOrb size={size} />
    case 'spinning':
      return <SpinningOrb size={size} />
    case 'compacting':
      return <CompactingOrb size={size} />
    // Package painters, re-scaled by tuneOpts().
    case 'waiting':
      return <PackageOrb state="listening" size={size} />
    case 'retrying':
      return <PackageOrb state="searching" size={size} />
  }
}

export interface ActivityStatusFlags {
  isAwaitingInput?: boolean
  isCompacting?: boolean
  apiRetry?: { attempt: number; maxRetries?: number } | null
  isThinking?: boolean
  /** activeForm of the in-progress todo — replaces "Working..." as the label. */
  activeForm?: string | null
}

/** One precedence order for both the label and its matching orb animation. */
export function deriveActivityStatus({
  isAwaitingInput,
  isCompacting,
  apiRetry,
  isThinking,
  activeForm,
}: ActivityStatusFlags): { statusText: string; orbState: ActivityOrbState } {
  if (isAwaitingInput) return { statusText: 'Waiting for input...', orbState: 'waiting' }
  if (isCompacting) return { statusText: 'Compacting...', orbState: 'compacting' }
  if (apiRetry) {
    return {
      statusText: `Retrying... (attempt ${apiRetry.attempt}${apiRetry.maxRetries ? `/${apiRetry.maxRetries}` : ''})`,
      orbState: 'retrying',
    }
  }
  if (isThinking) return { statusText: 'Thinking...', orbState: 'working' }
  return { statusText: activeForm || 'Working...', orbState: 'working' }
}

