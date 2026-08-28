import { useEffect, useRef } from 'react'

/**
 * Drifting colour bloom behind the Home empty state.
 *
 * Copied from the cloud-switcher-simple animation handoff's full-spectrum
 * glow: seven SOLID spectrum circles fused into one cloud by a single
 * blur+saturate on their stage (blurring the union is what makes overlapping
 * colours optically mix), the stage squashed to a band with scaleY(0.5), and
 * each blob drifting on its own lissajous path — golden-angle phase offsets
 * and per-blob angular speeds, so no pairing of blobs ever repeats and the
 * colours slide past and blend instead of moving as a sheet. Those paths are
 * true sin/cos combinations, which is why this is a rAF clock and not CSS
 * keyframes. Geometry and drift constants are the handoff's, verbatim.
 *
 * Adaptations for ambient use (the handoff blooms around a click): it fades
 * in once on mount and then holds, the stage scales to the host's width, and
 * the clock pauses offscreen/in hidden tabs and holds a mid-drift poster
 * frame under prefers-reduced-motion — time accumulates from frame deltas,
 * so pausing never leaves a gap to jump across.
 */
const GLOW_COLORS = ['#FF5C5C', '#FFB74D', '#FFE24D', '#6EDB8F', '#4EB3FF', '#8A7DFF', '#E07DFF']

// Handoff design space: 600x460 glow stage, 240px blobs drifting about
// (180,110) with 130x80 amplitude.
const STAGE_W = 600
const STAGE_H = 460
/**
 * Fraction of the host's width the band spans. The handoff's held composition
 * effectively fills its scene (600 stage x ~1.2 swell x 1.32 camera ≈ its
 * full 960 width, i.e. ~0.95); ours sits tighter around the card by request.
 */
const FILL = 0.68
/**
 * Ambient time scale on the handoff's drift (its 6s clip runs the paths at
 * full speed; held on a page they read calmer slowed a touch). Applied to
 * the clock's t, so the path SHAPES — speeds, phases — stay the verbatim
 * copy.
 */
const DRIFT = 0.6
/** Frame held under prefers-reduced-motion: mid-drift, colours well spread. */
const POSTER_T = 3.0
const FADE_IN_S = 0.65

const easeOut = (u: number) => 1 - Math.pow(1 - u, 3)

export function HomeEmptyClouds() {
  const wrapRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const wrap = wrapRef.current
    const stage = stageRef.current
    if (!wrap || !stage) return

    const toScale = (w: number) => Math.min(Math.max((w * FILL) / STAGE_W, 0.7), 2.2)
    let scale = toScale(wrap.clientWidth || STAGE_W)

    // The filter runs in the stage's LOCAL space, before the transform, so an
    // uncompensated blur is magnified by `scale` — at ~2x it dissolves the
    // blob cores into pale haze. Dividing keeps the EFFECTIVE radius at the
    // handoff's ~85px look (70px under its 1.2 swell x 1.32 camera).
    const applyFilter = () => {
      stage.style.filter = `blur(${85 / scale}px) saturate(1.1)`
    }
    applyFilter()

    const paint = (rawT: number, fade: number) => {
      const t = rawT * DRIFT
      const swell = 1.05 + 0.04 * Math.sin(t * 1.8)
      stage.style.opacity = String(fade)
      stage.style.transform = `translate(-50%, -50%) scale(${scale * swell}) scaleY(0.58)`
      const blobs = stage.children
      for (let i = 0; i < blobs.length; i++) {
        const ph = i * 2.39 // golden-angle phase offsets
        const w1 = 0.9 + 0.25 * (i % 3) // per-blob angular speeds
        const w2 = 0.7 + 0.2 * ((i + 1) % 3)
        const bx = 180 + 130 * Math.sin(w1 * t + ph)
        const by = 110 + 80 * Math.cos(w2 * t + ph * 1.7)
        ;(blobs[i] as HTMLElement).style.transform = `translate(${bx}px, ${by}px)`
      }
    }

    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    let inView = true
    let raf = 0
    let last = 0
    let t = 0

    const running = () => inView && !document.hidden && !reduced?.matches

    const tick = (now: number) => {
      raf = 0
      t += Math.min((now - last) / 1000, 0.1) // clamp so a stalled tab does not jump
      last = now
      paint(t, easeOut(Math.min(t / FADE_IN_S, 1)))
      if (running()) raf = requestAnimationFrame(tick)
    }

    const sync = () => {
      if (reduced?.matches) {
        if (raf) cancelAnimationFrame(raf)
        raf = 0
        paint(POSTER_T / DRIFT, 1)
        return
      }
      if (running() && !raf) {
        last = performance.now()
        raf = requestAnimationFrame(tick)
      } else if (!running() && raf) {
        cancelAnimationFrame(raf)
        raf = 0
      }
    }

    const ro = new ResizeObserver((entries) => {
      scale = toScale(entries[0].contentRect.width)
      applyFilter()
      if (!raf) paint(reduced?.matches ? POSTER_T / DRIFT : t, reduced?.matches ? 1 : easeOut(Math.min(t / FADE_IN_S, 1)))
    })
    ro.observe(wrap)

    // Same visible-tab gating as the handoff's clock; jsdom and old engines
    // lack IntersectionObserver, where eager-visible is the repo's fallback.
    const io =
      typeof IntersectionObserver === 'undefined'
        ? null
        : new IntersectionObserver(([entry]) => { inView = entry.isIntersecting; sync() }, { threshold: 0.01 })
    io?.observe(wrap)
    document.addEventListener('visibilitychange', sync)
    reduced?.addEventListener('change', sync)

    sync()
    return () => {
      ro.disconnect()
      io?.disconnect()
      document.removeEventListener('visibilitychange', sync)
      reduced?.removeEventListener('change', sync)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [])

  return (
    <div
      ref={wrapRef}
      aria-hidden="true"
      data-testid="home-empty-clouds"
      // Theme factor multiplies with the stage's inline fade-in opacity. Both
      // run higher than the handoff's 0.5 peak because our glass card hides
      // the bloom's dense centre — the visible halo is its outer falloff —
      // and dark needs more still: these hues sink toward grey haze there.
      className="home-empty-glow-mask pointer-events-none absolute inset-0 overflow-hidden opacity-65 dark:opacity-75"
    >
      <div ref={stageRef} className="home-empty-glow" style={{ width: STAGE_W, height: STAGE_H }}>
        {GLOW_COLORS.map((c) => (
          <div key={c} style={{ background: c }} />
        ))}
      </div>
    </div>
  )
}
