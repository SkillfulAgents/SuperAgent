import { useEffect, useRef, useState } from 'react'
import { cn } from '@shared/lib/utils/cn'
import { isWindowActive, subscribeToWindowActive } from '@renderer/lib/window-active'
import {
  createHalftoneGpuField,
  halftoneGpuAvailable,
  parseHalftoneInk,
  type HalftoneGpuField,
} from './halftone-gpu'
import {
  HALFTONE_CURSOR_INFLUENCE,
  HalftoneFrameRenderer,
  type HalftoneState,
} from './halftone-renderer'

/**
 * Canvas halftone banner: a 3D-ish density field rendered as a grid of animated
 * dots whose size + opacity track the field value, with a circular vignette and
 * directional lighting for a lit-relief look. Two motifs ship:
 *   - `flow_3d` — the agent's working / idle / sleeping identity.
 *   - `pulse`   — slow rings from center, the needs-input state (drawn in orange
 *                 by the caller via the wrapper's ink color).
 * State changes the *character* of motion (speed/dim), set by the caller.
 *
 * It animates only while it can be seen and the window is the one in use: off
 * screen, in a hidden document, or in a window left open behind another app it
 * holds its last frame. A halftone that does not follow the pointer (a view's
 * backdrop) is computed and drawn on the GPU where it can be; one that does
 * (a card) on Canvas2D. docs/halftone-rendering.md has the measurements.
 */

export type { HalftoneState } from './halftone-renderer'

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
  /** Whether dots near the pointer swell (the cards do). Off for a backdrop. */
  followPointer?: boolean
  className?: string
}

const LAZY_ROOT_MARGIN = '320px 0px'

/**
 * Keep the decorative canvas out of the DOM until its card is near the
 * viewport. The lightweight wrapper preserves the widget's geometry while
 * avoiding canvas backing stores and renderer buffers for distant cards.
 */
export function LazyHalftone({ className, ...props }: HalftoneProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [shouldMount, setShouldMount] = useState(
    () => typeof IntersectionObserver === 'undefined'
  )

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    if (typeof IntersectionObserver === 'undefined') {
      setShouldMount(true)
      return
    }

    const observer = new IntersectionObserver(
      // Batched entries arrive oldest-first; only the last reflects the
      // current state.
      (entries) => setShouldMount(entries[entries.length - 1]?.isIntersecting ?? false),
      { rootMargin: LAZY_ROOT_MARGIN }
    )
    observer.observe(host)
    return () => observer.disconnect()
  }, [])

  return (
    <div ref={hostRef} className={cn('h-full w-full', className)} aria-hidden>
      {shouldMount && <Halftone {...props} />}
    </div>
  )
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
  followPointer = true,
  className,
}: HalftoneProps) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // False once the GPU has let this halftone down, which sends it to Canvas2D for good.
  const [gpuAllowed, setGpuAllowed] = useState(true)
  // The pointer's influence eases per dot over time: state the GPU field does not keep.
  const surface = gpuAllowed && !followPointer && halftoneGpuAvailable() ? 'gpu' : '2d'

  useEffect(() => {
    const wrap = wrapRef.current
    const canvas = canvasRef.current
    if (!wrap || !canvas) return

    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    const fill = color ?? getComputedStyle(canvas).color
    const speed = (speedProp ?? (state === 'idle' ? 0.2 : state === 'alert' ? 1.6 : 0.75)) * speedScale
    const field = { motif, state, spacing, maxRadius, vignette, contrast, dim, seed }

    let stopped = false
    let gpu: HalftoneGpuField | null = null
    let ctx: CanvasRenderingContext2D | null = null
    let renderer: HalftoneFrameRenderer | null = null
    if (surface === 'gpu') {
      const ink = parseHalftoneInk(fill)
      gpu = ink && createHalftoneGpuField(canvas, {
        ...field,
        ink,
        onLost: () => {
          if (!stopped) setGpuAllowed(false)
        },
      })
      if (!gpu) {
        // A canvas keeps the kind of context it was first asked for, so the
        // Canvas2D fallback draws on a fresh one (the canvas is keyed by surface).
        setGpuAllowed(false)
        return
      }
    } else {
      ctx = canvas.getContext('2d')
      if (!ctx) return
      renderer = new HalftoneFrameRenderer({ ...field, color: fill })
    }

    let raf = 0
    let ready = false
    // Whether the canvas shows a frame at its current size (resizing clears it).
    let painted = false
    let lastDrawTime = 0
    let t = 0
    let W = 0, H = 0
    let pixelRatio = 0
    let pointerX = 0, pointerY = 0, pointerSeen = false
    const onPointerMove = (e: PointerEvent) => {
      pointerX = e.clientX
      pointerY = e.clientY
      pointerSeen = true
    }

    function setup(): boolean {
      const nextWidth = wrap!.clientWidth
      const nextHeight = wrap!.clientHeight
      if (nextWidth <= 0 || nextHeight <= 0) {
        ready = false
        return false
      }
      const nextPixelRatio = window.devicePixelRatio || 1
      if (
        ready &&
        nextWidth === W &&
        nextHeight === H &&
        nextPixelRatio === pixelRatio
      ) {
        return true
      }
      W = nextWidth
      H = nextHeight
      pixelRatio = nextPixelRatio
      painted = false
      canvas!.width = Math.round(W * pixelRatio)
      canvas!.height = Math.round(H * pixelRatio)
      ctx?.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
      renderer?.resize(W, H)
      gpu?.resize(W, H, pixelRatio)
      ready = true
      return true
    }

    function draw(frameScale = 1) {
      painted = true
      if (gpu) {
        gpu.draw(t)
        return
      }
      // Pointer position relative to this canvas (recomputed once per frame).
      let mActive = false, mx = 0, my = 0
      if (pointerSeen) {
        const rect = wrap!.getBoundingClientRect()
        mx = pointerX - rect.left
        my = pointerY - rect.top
        mActive =
          mx >= -HALFTONE_CURSOR_INFLUENCE &&
          mx <= W + HALFTONE_CURSOR_INFLUENCE &&
          my >= -HALFTONE_CURSOR_INFLUENCE &&
          my <= H + HALFTONE_CURSOR_INFLUENCE
      }
      renderer!.draw(ctx!, t, 'alpha-buckets', mx, my, mActive, frameScale)
    }

    // IntersectionObserver callbacks are asynchronous. Starting as visible
    // lets every offscreen card enter its RAF loop before the observer can
    // classify it, which can starve those callbacks on large home boards.
    // Browsers without IntersectionObserver retain the eager fallback.
    let intersecting = typeof IntersectionObserver === 'undefined'
    let windowActive = isWindowActive()
    let pointerListening = false

    const setPointerListening = (next: boolean) => {
      if (next === pointerListening) return
      pointerListening = next
      if (next) {
        window.addEventListener('pointermove', onPointerMove, { passive: true })
      } else {
        window.removeEventListener('pointermove', onPointerMove)
        pointerSeen = false
      }
    }

    const frameInterval = 1000 / 30
    const frameTolerance = 4
    function frame(now: number) {
      raf = 0
      if (stopped || !ready || !intersecting || !windowActive || document.hidden) return
      const elapsed = lastDrawTime === 0 ? frameInterval : now - lastDrawTime
      if (elapsed >= frameInterval - frameTolerance) {
        const frameScale = elapsed / (1000 / 60)
        // Layout can change before ResizeObserver runs later in this frame.
        // It will resize and repaint synchronously; skip the old-size bitmap
        // that would immediately be discarded, but advance time as usual.
        if (wrap!.clientWidth === W && wrap!.clientHeight === H) draw(frameScale)
        // Preserve the original 60fps phase velocity while drawing half as
        // often, substantially reducing per-card field math and Canvas2D paths.
        t += speed * frameScale
        lastDrawTime = now
      }
      raf = requestAnimationFrame(frame)
    }

    const syncAnimation = () => {
      const visible = ready && intersecting && !document.hidden && !stopped
      const active = visible && !reduce && windowActive
      // Held still in an inactive window, it still shows a frame.
      if (visible && !reduce && !windowActive && !painted) draw(0)
      setPointerListening(active && followPointer)
      if (active && raf === 0) {
        lastDrawTime = 0
        raf = requestAnimationFrame(frame)
      } else if (!active && raf !== 0) {
        cancelAnimationFrame(raf)
        raf = 0
      }
    }

    const ro = new ResizeObserver(() => {
      const measured = setup()
      // Resizing clears the bitmap after RAF callbacks have run. Repaint before
      // the browser presents it, without advancing the animation or cursor easing.
      if (measured && intersecting && !document.hidden) draw(0)
      syncAnimation()
    })
    ro.observe(wrap)

    if (setup()) {
      if (reduce && intersecting) draw()
      else syncAnimation()
    }

    const io =
      typeof IntersectionObserver === 'undefined'
        ? null
        : new IntersectionObserver((entries) => {
            // Batched entries arrive oldest-first; only the last reflects the
            // current state.
            intersecting = entries[entries.length - 1]?.isIntersecting ?? false
            if (reduce) {
              if (intersecting && ready) draw()
            } else {
              syncAnimation()
            }
          })
    io?.observe(wrap)

    const onVisibilityChange = () => {
      if (reduce) {
        if (!document.hidden && intersecting && ready) draw()
      } else {
        syncAnimation()
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)

    // A still frame under reduced motion has nothing to pause.
    const unsubscribeWindowActive = reduce
      ? undefined
      : subscribeToWindowActive((next) => {
          windowActive = next
          syncAnimation()
        })

    return () => {
      stopped = true
      cancelAnimationFrame(raf)
      ro.disconnect()
      io?.disconnect()
      document.removeEventListener('visibilitychange', onVisibilityChange)
      unsubscribeWindowActive?.()
      setPointerListening(false)
      gpu?.dispose()
    }
  }, [motif, state, speedProp, color, spacing, maxRadius, vignette, contrast, speedScale, dim, seed, followPointer, surface])

  return (
    <div ref={wrapRef} className={cn('h-full w-full', className)} aria-hidden>
      <canvas key={surface} ref={canvasRef} className="block h-full w-full" />
    </div>
  )
}
