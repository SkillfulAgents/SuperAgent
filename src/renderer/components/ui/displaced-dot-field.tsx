import { useEffect, useRef } from 'react'
import { cn } from '@shared/lib/utils/cn'
import { useIsDark } from '@renderer/hooks/use-theme'

// The website's hero dot grid (gamut-website, src/components/home2/DisplacedDotField.tsx),
// same lattice, feel, ripple and intro, with a fixed simulation rate and bounded
// drawing batches. The dot colour follows the canvas's own `color` and the app's theme.

const SPACING = 12 // px between dots
const DOT_RADIUS = 0.8
const REACH = 180 // px — how far the cursor pushes
const PUSH = 3 // outward kick per frame at the cursor, fading linearly to REACH
const WAKE = 0.22 // share of the cursor's own velocity dragged into the dots
const SPRING = 0.02 // pull back toward the grid while the cursor or a ripple is active
const HEAL_SPRING = 0.01 // softer pull once everything stops — how slowly it heals
const DAMPING = 0.7 // velocity kept per frame — lower is thicker, more viscous
const STIR_DECAY = 0.8 // per frame — the push fades out ~0.3s after the mouse stops
const REST_SPEED = 0.01 // px/frame — the fastest dot must be slower than this
const REST_OFFSET = 0.3 // px — every dot must be this close to its grid point
// The physics constants describe a 60 Hz simulation, independent of the display's refresh rate.
const STEP_MS = 1000 / 60
const MAX_CATCHUP_MS = STEP_MS * 5
// Very large compound paths make canvas fills expensive, especially the intro's Path2Ds.
const DOTS_PER_PATH = 256
// Only a moving cursor pushes. While it moves, dots settle toward
// PUSH·(1 − d/REACH) = SPRING·offset — a hole up to ~80px across ringed by
// displaced dots. When it stops the push fades and the field heals back onto
// the grid, even with the cursor still over it. Heavy damping and soft springs
// keep every motion overdamped, so dots ease where they're pushed and ease home
// again without bouncing.

// A click on the background sends one ring outward across the whole grid.
const RIPPLE_SPEED = 8 // px per frame the ring travels
const RIPPLE_BAND = 64 // px either side of the ring that feels it
const RIPPLE_KICK = 3.5 // outward kick per frame at the crest
// The intro (optional): on load the grid boots up as a wave from ORIGIN, dots
// appearing as the front reaches them on a bright blue crest that settles back
// to the field's grey behind it.
const INTRO_SPEED = 1.25 // px per ms the front travels
const INTRO_FADE = 120 // ms for a dot to fade in once the front reaches it
const INTRO_GLOW = 520 // ms its blue crest takes to settle
const INTRO_ORIGIN = { x: 0.25, y: 0.35 } // share of the field's width / height
const INTRO_RGB = [0, 153, 255] // the brand blue
const LEVELS = 6 // shades the crest is drawn in (batched within each shade)

// Clicks on these never ripple: controls, and anything a page marks.
const NO_RIPPLE = 'a, button, input, textarea, select, label, [role], [contenteditable="true"], [data-no-ripple]'

/** `rgb(…)` or `rgba(…)` as its three channels; dark grey if the colour can't be read. */
function channels(color: string): [number, number, number] {
  const [r, g, b] = color.match(/\d+(\.\d+)?/g)?.map(Number) ?? []
  return r === undefined || g === undefined || b === undefined ? [12, 11, 10] : [r, g, b]
}

/**
 * A dot grid the cursor wades through: dots near a moving pointer are shoved
 * outward and dragged along its path, then heal back into the grid once it
 * stops, and a click on the background ripples through the whole field. With
 * `intro` it boots up as a wave on load. The canvas never takes pointer events
 * — it listens on the window — so the content above it stays fully
 * interactive. Reduced motion gets the static grid.
 */
export function DisplacedDotField({
  className,
  alpha = 0.2,
  rippleExclude,
  intro = false,
}: {
  /** Sets the dot colour through `color` (the default is the foreground). */
  className?: string
  /** Every dot's opacity, moving or not. */
  alpha?: number
  /** Extra selector for regions whose clicks shouldn't ripple. Controls never ripple. */
  rippleExclude?: string
  /** Boot the grid up with a wave on load (skipped with reduced motion). */
  intro?: boolean
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const refreshColorRef = useRef<(() => void) | null>(null)
  const isDark = useIsDark()

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return

    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
    let color = getComputedStyle(canvas).color
    let rgb = channels(color)
    let dpr = 1
    let width = 0
    let height = 0
    let cols = 0
    let rows = 0
    // Per dot: offset from its grid point, and velocity.
    let ox = new Float32Array(0)
    let oy = new Float32Array(0)
    let vx = new Float32Array(0)
    let vy = new Float32Array(0)

    // `stir` is how hard the cursor is pushing: 1 on every move, fading to 0 once it holds still.
    const pointer = { x: 0, y: 0, dx: 0, dy: 0, stir: 0, inside: false, moved: false }
    // Rings in flight: their center, and how far they've travelled.
    let ripples: { x: number; y: number; r: number }[] = []
    let raf = 0
    let running = false
    let visible = true
    let lastFrameAt = 0
    let elapsed = 0
    // When the intro started, and how long it runs for this field's size.
    let introStart = intro && !reduced ? performance.now() : -Infinity
    let introLength = 0
    const introActive = () => performance.now() - introStart < introLength

    function resize() {
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const nextDpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1))
      if (width === rect.width && height === rect.height && dpr === nextDpr) return
      dpr = nextDpr
      width = rect.width
      height = rect.height
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      cols = Math.ceil(width / SPACING) + 1
      rows = Math.ceil(height / SPACING) + 1
      const n = cols * rows
      ox = new Float32Array(n)
      oy = new Float32Array(n)
      vx = new Float32Array(n)
      vy = new Float32Array(n)
      const far = Math.hypot(
        Math.max(INTRO_ORIGIN.x, 1 - INTRO_ORIGIN.x) * width,
        Math.max(INTRO_ORIGIN.y, 1 - INTRO_ORIGIN.y) * height,
      )
      introLength = far / INTRO_SPEED + INTRO_FADE + INTRO_GLOW
      draw()
    }

    // Center the lattice so the margins match on both sides.
    const originX = () => (width - (cols - 1) * SPACING) / 2
    const originY = () => (height - (rows - 1) * SPACING) / 2

    // Returns [max speed, max offset] across the field: maxima, so a few
    // stragglers can't park off-grid in a darker shade.
    function step(): [number, number] {
      let speed = 0
      let offset = 0
      const x0 = originX()
      const y0 = originY()
      const stir = pointer.inside ? pointer.stir : 0
      const push = stir > 0.001
      const activity = Math.max(stir, ripples.length > 0 ? 1 : 0)
      const spring = HEAL_SPRING + (SPRING - HEAL_SPRING) * activity
      // A ring fades as it travels, but reaches the far corner still visible.
      const maxR = Math.hypot(width, height) + RIPPLE_BAND
      const rings = ripples.map((rp) => ({ ...rp, kick: RIPPLE_KICK * (1 - 0.6 * (rp.r / maxR)) }))
      for (let r = 0, i = 0; r < rows; r++) {
        const gy = y0 + r * SPACING
        for (let c = 0; c < cols; c++, i++) {
          const gx = x0 + c * SPACING
          for (const ring of rings) {
            const dx = gx - ring.x
            const dy = gy - ring.y
            const d = Math.hypot(dx, dy)
            const band = Math.abs(d - ring.r)
            if (band < RIPPLE_BAND && d > 0.5) {
              const k = (1 - band / RIPPLE_BAND) * ring.kick
              vx[i] += (dx / d) * k
              vy[i] += (dy / d) * k
            }
          }
          if (push) {
            const dx = gx + ox[i] - pointer.x
            const dy = gy + oy[i] - pointer.y
            const d2 = dx * dx + dy * dy
            if (d2 < REACH * REACH) {
              const d = Math.sqrt(d2)
              const k = (1 - d / REACH) * stir
              // A dot dead under the cursor has no "away"; give each one a fixed direction of its own.
              const ux = d > 0.5 ? dx / d : Math.cos(i * 2.39996)
              const uy = d > 0.5 ? dy / d : Math.sin(i * 2.39996)
              vx[i] += ux * PUSH * k + pointer.dx * WAKE * k
              vy[i] += uy * PUSH * k + pointer.dy * WAKE * k
            }
          }
          vx[i] = (vx[i] - ox[i] * spring) * DAMPING
          vy[i] = (vy[i] - oy[i] * spring) * DAMPING
          ox[i] += vx[i]
          oy[i] += vy[i]
          speed = Math.max(speed, Math.abs(vx[i]), Math.abs(vy[i]))
          offset = Math.max(offset, Math.abs(ox[i]), Math.abs(oy[i]))
        }
      }
      // The wake only carries the motion of the frame it happened in, and the
      // push itself fades while the cursor holds still.
      pointer.dx *= 0.5
      pointer.dy *= 0.5
      pointer.stir *= STIR_DECAY
      for (const rp of ripples) rp.r += RIPPLE_SPEED
      ripples = ripples.filter((rp) => rp.r < maxR)
      return [speed, offset]
    }

    // The intro frame: each dot's reveal and crest depend on when the front
    // reached it. Bucket by (fade, crest), then bound each path's size within that shade.
    function drawIntro(context: CanvasRenderingContext2D, elapsed: number, [br, bg, bb]: [number, number, number]) {
      const x0 = originX()
      const y0 = originY()
      const cx = INTRO_ORIGIN.x * width
      const cy = INTRO_ORIGIN.y * height
      const buckets = new Map<number, { paths: Path2D[]; count: number }>()
      for (let r = 0, i = 0; r < rows; r++) {
        const gy = y0 + r * SPACING
        for (let c = 0; c < cols; c++, i++) {
          const gx = x0 + c * SPACING
          const since = elapsed - Math.hypot(gx - cx, gy - cy) / INTRO_SPEED
          if (since <= 0) continue
          const fade = Math.min(1, since / INTRO_FADE)
          const crest = Math.max(0, 1 - since / INTRO_GLOW)
          const f = Math.ceil(fade * (LEVELS - 1))
          const g = Math.round(crest * (LEVELS - 1))
          const key = f * LEVELS + g
          let bucket = buckets.get(key)
          if (!bucket) buckets.set(key, (bucket = { paths: [], count: 0 }))
          if (bucket.count++ % DOTS_PER_PATH === 0) bucket.paths.push(new Path2D())
          const path = bucket.paths[bucket.paths.length - 1]
          const x = gx + ox[i]
          const y = gy + oy[i]
          const rad = DOT_RADIUS * (1 + 0.6 * (g / (LEVELS - 1)))
          path.moveTo(x + rad, y)
          path.arc(x, y, rad, 0, Math.PI * 2)
        }
      }
      for (const [key, { paths }] of buckets) {
        const f = Math.floor(key / LEVELS) / (LEVELS - 1)
        const g = (key % LEVELS) / (LEVELS - 1)
        const mix = (base: number, to: number) => Math.round(base + (to - base) * g)
        context.fillStyle = `rgba(${mix(br, INTRO_RGB[0])}, ${mix(bg, INTRO_RGB[1])}, ${mix(bb, INTRO_RGB[2])}, ${Math.min(1, alpha * f + 0.4 * g * f)})`
        for (const path of paths) context.fill(path)
      }
    }

    function draw() {
      if (!canvas || !ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, width, height)
      if (introActive()) {
        drawIntro(ctx, performance.now() - introStart, rgb)
        return
      }
      const x0 = originX()
      const y0 = originY()
      // Small compound paths keep a large field cheap to rasterize.
      ctx.fillStyle = `rgba(${rgb.join(', ')}, ${alpha})`
      ctx.beginPath()
      for (let r = 0, i = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++, i++) {
          const x = x0 + c * SPACING + ox[i]
          const y = y0 + r * SPACING + oy[i]
          ctx.moveTo(x + DOT_RADIUS, y)
          ctx.arc(x, y, DOT_RADIUS, 0, Math.PI * 2)
          if ((i + 1) % DOTS_PER_PATH === 0) {
            ctx.fill()
            ctx.beginPath()
          }
        }
      }
      ctx.fill()
    }

    // Runs only while something is moving, and parks once the field has healed back onto the grid.
    function frame(now: number) {
      elapsed += Math.min(Math.max(0, now - lastFrameAt), MAX_CATCHUP_MS)
      lastFrameAt = now
      // Carry fractional steps across frames: 120 Hz draws every other frame; 30 Hz advances twice per frame.
      const steps = Math.floor((elapsed + 1e-6) / STEP_MS)
      elapsed = Math.max(0, elapsed - steps * STEP_MS)
      if (steps === 0) {
        raf = requestAnimationFrame(frame)
        return
      }
      let speed = 0
      let offset = 0
      for (let i = 0; i < steps; i++) [speed, offset] = step()
      const moving = pointer.moved
      pointer.moved = false
      const settled =
        !introActive() && ripples.length === 0 && pointer.stir < 0.01 && speed < REST_SPEED && offset < REST_OFFSET
      if (settled && !moving) {
        // Finish the last fraction of a pixel exactly, so the field parks on the grid rather than near it.
        ox.fill(0)
        oy.fill(0)
        vx.fill(0)
        vy.fill(0)
        draw()
        running = false
        return
      }
      draw()
      raf = requestAnimationFrame(frame)
    }

    function wake() {
      if (running || !visible || reduced) return
      running = true
      lastFrameAt = performance.now()
      elapsed = 0
      raf = requestAnimationFrame(frame)
    }

    function onPointerMove(event: PointerEvent) {
      if (!canvas || event.pointerType === 'touch') return
      const rect = canvas.getBoundingClientRect()
      const x = event.clientX - rect.left
      const y = event.clientY - rect.top
      const inside = x > -REACH && y > -REACH && x < rect.width + REACH && y < rect.height + REACH
      if (pointer.inside && inside) {
        pointer.dx += x - pointer.x
        pointer.dy += y - pointer.y
      } else {
        pointer.dx = 0
        pointer.dy = 0
      }
      const left = pointer.inside && !inside
      pointer.x = x
      pointer.y = y
      pointer.inside = inside
      if (inside) {
        pointer.moved = true
        pointer.stir = 1
      }
      // Leaving wakes the field too, so the dimple springs back.
      if (inside || left) wake()
    }

    function onPointerLeave() {
      pointer.inside = false
      wake()
    }

    // A plain click on the background (not a control, not the end of a text
    // selection) pushes the dots aside as a move would, and starts a ring there.
    function onClick(event: MouseEvent) {
      if (!canvas || event.button !== 0) return
      const target = event.target as Element | null
      if (target?.closest(NO_RIPPLE)) return
      if (rippleExclude && target?.closest(rippleExclude)) return
      if (!window.getSelection()?.isCollapsed) return
      const rect = canvas.getBoundingClientRect()
      const x = event.clientX - rect.left
      const y = event.clientY - rect.top
      if (x < 0 || y < 0 || x > rect.width || y > rect.height) return
      Object.assign(pointer, { x, y, dx: 0, dy: 0, inside: true, stir: 1, moved: true })
      ripples.push({ x, y, r: 0 })
      wake()
    }

    resize()
    refreshColorRef.current = () => {
      const next = getComputedStyle(canvas).color
      if (next === color) return
      color = next
      rgb = channels(color)
      // Also repaint a parked or reduced-motion field, without restarting its intro or physics.
      draw()
    }
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize)
    resizeObserver?.observe(canvas)
    // Run the intro's frames; the loop parks itself once it's over.
    if (introActive()) wake()

    // jsdom and old engines lack IntersectionObserver; eager-visible is the fallback.
    const intersectionObserver =
      typeof IntersectionObserver === 'undefined'
        ? null
        : new IntersectionObserver(([entry]) => {
            visible = entry.isIntersecting
            if (!visible) {
              cancelAnimationFrame(raf)
              running = false
              // Scrolled away mid-intro: show the plain grid when it's back.
              introStart = -Infinity
              draw()
            } else wake()
          })
    intersectionObserver?.observe(canvas)

    if (!reduced) {
      window.addEventListener('pointermove', onPointerMove, { passive: true })
      window.addEventListener('click', onClick)
      document.documentElement.addEventListener('pointerleave', onPointerLeave)
    }

    return () => {
      refreshColorRef.current = null
      cancelAnimationFrame(raf)
      resizeObserver?.disconnect()
      intersectionObserver?.disconnect()
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('click', onClick)
      document.documentElement.removeEventListener('pointerleave', onPointerLeave)
    }
  }, [alpha, rippleExclude, intro])

  useEffect(() => {
    refreshColorRef.current?.()
  }, [isDark, className])

  return <canvas ref={canvasRef} aria-hidden="true" className={cn('pointer-events-none block size-full text-foreground', className)} />
}
