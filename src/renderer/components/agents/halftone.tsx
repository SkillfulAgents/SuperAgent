import { useEffect, useRef } from 'react'
import { cn } from '@shared/lib/utils/cn'

/**
 * Canvas halftone banner: a 3D-ish density field rendered as a grid of animated
 * dots whose size + opacity track the field value, with a circular vignette and
 * directional lighting for a lit-relief look. Two motifs ship:
 *   - `flow_3d` — the agent's working / idle / sleeping identity.
 *   - `pulse`   — slow rings from center, the needs-input state (drawn in orange
 *                 by the caller via the wrapper's ink color).
 * State changes the *character* of motion (speed/dim), set by the caller.
 */

/** A cell is either a plain density (0..1) or a shaded {brightness, radius}. */
type Cell = number | { a: number; r: number }
/** Optional per-card rotation of the field (cos/sin), so cards flow in different directions. */
type Rot = { cos: number; sin: number }
type DensityFn = (i: number, j: number, C: number, R: number, t: number, rot?: Rot) => Cell

// Light: slightly upper-left, tilted toward the viewer.
const LIGHT = (() => {
  const lx = 0.32, ly = -0.55, lz = 0.78
  const nl = Math.sqrt(lx * lx + ly * ly + lz * lz)
  return { x: lx / nl, y: ly / nl, z: lz / nl }
})()

interface ShadeOpts { baseA?: number; litA?: number; baseR?: number; heightR?: number }

/** Shade a cell from a height sample + its eps-neighbours (normal vs. LIGHT). */
function shade(h00: number, hX: number, hY: number, eps: number, opts: ShadeOpts = {}): { a: number; r: number } {
  const nx = -(hX - h00) / eps
  const ny = -(hY - h00) / eps
  const nl = Math.sqrt(nx * nx + ny * ny + 1)
  const lit = Math.max(0, (nx * LIGHT.x + ny * LIGHT.y + LIGHT.z) / nl)
  const baseA = opts.baseA ?? 0.15
  const litA = opts.litA ?? 0.85
  const baseR = opts.baseR ?? 0.6
  const heightR = opts.heightR ?? 1.4
  return { a: Math.min(1, baseA + lit * litA), r: Math.max(0.2, baseR + Math.max(0, h00) * heightR) }
}

// ---- flow_3d: lit curl-noise streams rippling across the field ----
const flowH = (u: number, v: number, t: number): number =>
  0.3 * Math.sin(u * 7 - t * 0.04) + 0.2 * Math.sin(u * 13 + v * 6 - t * 0.05) + 0.15 * Math.sin(u * 4 + v * 11 + t * 0.03)
const densityFlow3D: DensityFn = (i, j, C, R, t, rot) => {
  const u = i / C, v = j / R, e = 0.5 / C
  // Sample the flow field, optionally rotated around center so each card's
  // streams drift in a different direction.
  const sample = (uu: number, vv: number): number => {
    if (!rot) return flowH(uu, vv, t)
    const du = uu - 0.5, dv = vv - 0.5
    return flowH(0.5 + du * rot.cos - dv * rot.sin, 0.5 + du * rot.sin + dv * rot.cos, t)
  }
  return shade(sample(u, v) + 0.65, sample(u + e, v) + 0.65, sample(u, v + e) + 0.65, e, {
    baseA: 0.18,
    litA: 0.74,
    baseR: 0.45,
    heightR: 1.9,
  })
}

// ---- pulse: slow broad rings emanating from center (the needs-input default) ----
const pulseH = (u: number, v: number, t: number): number => {
  const dx = u - 0.5, dy = v - 0.5
  const r = Math.sqrt(dx * dx + dy * dy)
  let h = 0
  const phase = (t * 0.0024) % 1
  for (let k = 0; k < 2; k++) {
    const age = (phase + k * 0.5) % 1
    const ringR = age * 0.8
    const band = Math.exp(-Math.pow((r - ringR) * 5.5, 2)) // smooth broad ring
    h += band * (1 - age) // fade out as the ring expands
  }
  return h
}
const densityPulse: DensityFn = (i, j, C, R, t) => {
  const u = i / C, v = j / R, e = 0.5 / C
  const h0 = pulseH(u, v, t)
  if (h0 < 0.05) return 0 // keep the gaps between rings empty — it's a pulse
  const sh = shade(h0 * 0.6 + 0.05, pulseH(u + e, v, t) * 0.6 + 0.05, pulseH(u, v + e, t) * 0.6 + 0.05, e, {
    baseA: 0.12,
    litA: 0.85,
    baseR: 0.4,
    heightR: 2.2,
  })
  return { a: sh.a * Math.min(1, h0 * 1.6), r: sh.r }
}

const DENSITY_FNS: Record<string, DensityFn> = {
  flow_3d: densityFlow3D,
  pulse: densityPulse,
}

// Cursor reactivity (ported from the gamut-website InteractiveDotMatrix): dots
// within CURSOR_INFLUENCE px of the pointer grow + brighten with a smooth
// falloff, each easing toward its target so the pull trails and fades.
const CURSOR_INFLUENCE = 90 // px
// Asymmetric easing: quick attack as the cursor nears, slow release so the
// trail lingers and fades gently after it passes.
const CURSOR_ATTACK = 0.18
const CURSOR_RELEASE = 0.04
const CURSOR_R = 1.6 // max added dot radius near the cursor
const CURSOR_A = 0.75 // max added alpha (darkening) near the cursor

export type HalftoneState = 'working' | 'idle' | 'alert'

interface HalftoneProps {
  motif: string
  state?: HalftoneState
  /** Override the per-tick time advance (speed of the animation). */
  speed?: number
  /** Ink color. Defaults to the wrapper's resolved `currentColor`. */
  color?: string
  /** Grid pitch in px (smaller = denser). */
  spacing?: number
  /** Max dot radius in px. */
  maxRadius?: number
  /** Edge-fade strength, 0..1. */
  vignette?: number
  /** Density→alpha multiplier — higher = darker / higher-contrast dots. */
  contrast?: number
  /** Multiplies the state-derived animation speed. */
  speedScale?: number
  /** Whole-field alpha multiplier (0..1). Defaults to 0.65 for idle, 1 otherwise. */
  dim?: number
  /** Per-card phase offset so cards aren't all animating in sync. */
  seed?: number
  className?: string
}

export function Halftone({
  motif,
  state = 'working',
  speed: speedProp,
  color,
  spacing = 6,
  maxRadius = 1.6,
  vignette = 0.22,
  contrast = 1.6,
  speedScale = 1,
  dim,
  seed = 0,
  className,
}: HalftoneProps) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const wrap = wrapRef.current
    const canvas = canvasRef.current
    if (!wrap || !canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    const fieldFn = DENSITY_FNS[motif] ?? densityFlow3D
    // Per-card rotation (from the seed) so flows don't all move the same way —
    // snapped to 20° increments (18 distinct directions) for clear variety.
    const rotAngle = (seed % 18) * 20 * (Math.PI / 180)
    const rot = { cos: Math.cos(rotAngle), sin: Math.sin(rotAngle) }
    const fill = color ?? getComputedStyle(canvas).color
    const speed = (speedProp ?? (state === 'idle' ? 0.2 : state === 'alert' ? 1.6 : 0.75)) * speedScale

    let raf = 0
    let stopped = false
    let t = seed % 1000 // phase offset so cards animate out of sync
    let W = 0, H = 0, COLS = 0, ROWS = 0, offsetX = 0, offsetY = 0, cx = 0, cy = 0
    let infl = new Float32Array(0) // per-cell eased cursor boost (0..1)
    let pointerX = 0, pointerY = 0, pointerSeen = false
    const onPointerMove = (e: PointerEvent) => {
      pointerX = e.clientX
      pointerY = e.clientY
      pointerSeen = true
    }

    function setup(): boolean {
      W = wrap!.clientWidth
      H = wrap!.clientHeight
      if (W === 0 || H === 0) return false
      const dpr = window.devicePixelRatio || 1
      canvas!.width = Math.round(W * dpr)
      canvas!.height = Math.round(H * dpr)
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0)
      COLS = Math.max(1, Math.floor(W / spacing))
      ROWS = Math.max(1, Math.floor(H / spacing))
      offsetX = (W - (COLS - 1) * spacing) / 2
      offsetY = (H - (ROWS - 1) * spacing) / 2
      cx = (COLS - 1) / 2
      cy = (ROWS - 1) / 2
      infl = new Float32Array(COLS * ROWS)
      return true
    }

    // Smoothstep radial vignette: a circular mask (Euclidean distance from
    // center) fades dots in both alpha and radius toward the edges.
    function vignetteAt(dx: number, dy: number): number {
      if (vignette <= 0) return 1
      const distN = Math.hypot(dx, dy)
      const start = 0.4 - vignette * 0.15
      let tNorm = (distN - start) / (1 - start)
      tNorm = Math.max(0, Math.min(1, tNorm))
      const smooth = tNorm * tNorm * (3 - 2 * tNorm)
      return 1 - (smooth * vignette) / 0.45
    }

    function draw() {
      ctx!.clearRect(0, 0, W, H)
      ctx!.fillStyle = fill
      // Pointer position relative to this canvas (recomputed once per frame).
      let mActive = false, mx = 0, my = 0
      if (pointerSeen) {
        const rect = wrap!.getBoundingClientRect()
        mx = pointerX - rect.left
        my = pointerY - rect.top
        mActive = mx >= -CURSOR_INFLUENCE && mx <= W + CURSOR_INFLUENCE && my >= -CURSOR_INFLUENCE && my <= H + CURSOR_INFLUENCE
      }
      const INF2 = CURSOR_INFLUENCE * CURSOR_INFLUENCE
      const dimF = dim ?? (state === 'idle' ? 0.65 : 1)
      for (let j = 0; j < ROWS; j++) {
        for (let i = 0; i < COLS; i++) {
          const out = fieldFn(i, j, COLS, ROWS, t, rot)
          let a: number, r: number
          if (typeof out === 'number') {
            a = Math.min(1, out * contrast)
            r = out * maxRadius
          } else {
            a = Math.min(1, out.a * contrast * 0.9)
            // Shaded radii are tuned for a ~2.4px max; scale to our maxRadius.
            r = out.r * (maxRadius / 2.4)
          }
          const px = offsetX + i * spacing, py = offsetY + j * spacing
          // Eased cursor pull: dots near the pointer grow + brighten.
          const idx = j * COLS + i
          let target = 0
          if (mActive) {
            const ddx = px - mx, ddy = py - my
            const d2 = ddx * ddx + ddy * ddy
            if (d2 < INF2) {
              const tt = 1 - Math.sqrt(d2) / CURSOR_INFLUENCE
              target = tt * tt
            }
          }
          const cur = infl[idx]
          const h = (infl[idx] = cur + (target - cur) * (target > cur ? CURSOR_ATTACK : CURSOR_RELEASE))
          if (h > 0.003) r += h * CURSOR_R
          const v = vignetteAt((i - cx) / cx, (j - cy) / cy)
          if (v <= 0) continue
          // Cursor darkening is added on top of the state-dimmed alpha, so dots
          // read clearly darker near the pointer even in faint states.
          let alpha = a * v * dimF
          if (h > 0.003) alpha += h * v * CURSOR_A
          alpha = Math.min(1, alpha)
          const rr = r * (0.35 + 0.65 * v)
          if (alpha < 0.02 || rr < 0.2) continue
          ctx!.globalAlpha = alpha
          ctx!.beginPath()
          ctx!.arc(px, py, rr, 0, Math.PI * 2)
          ctx!.fill()
        }
      }
    }

    function frame() {
      if (stopped) return
      draw()
      t += speed
      raf = requestAnimationFrame(frame)
    }

    if (!setup()) return
    if (reduce) draw()
    else frame()

    const ro = new ResizeObserver(() => {
      if (setup() && reduce) draw()
    })
    ro.observe(wrap)
    if (!reduce) window.addEventListener('pointermove', onPointerMove, { passive: true })

    return () => {
      stopped = true
      cancelAnimationFrame(raf)
      ro.disconnect()
      window.removeEventListener('pointermove', onPointerMove)
    }
  }, [motif, state, speedProp, color, spacing, maxRadius, vignette, contrast, speedScale, dim, seed])

  return (
    <div ref={wrapRef} className={cn('h-full w-full', className)} aria-hidden>
      <canvas ref={canvasRef} className="block h-full w-full" />
    </div>
  )
}
