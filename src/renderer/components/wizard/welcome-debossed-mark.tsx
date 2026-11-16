import { useEffect, useId, useRef } from 'react'
import { subscribeToFrames } from '@renderer/components/agents/agent-avatar/orb-ticker'
import { observeOrbVisibility } from '@renderer/components/agents/agent-avatar/orb-visibility'

/** The Gamut logomark, as in the app icon's source (build/icon.icon/Assets/gamut_logomark_white.svg). */
const MARK = 'M78.0056 314.341C100.937 354.026 131.37 393.855 168.486 430.971C208.357 470.841 251.358 503 293.949 526.432C266.624 554.832 228.44 572.471 186.187 572.471C103.108 572.471 35.7585 504.282 35.7585 420.167C35.7586 379.052 51.851 341.742 78.0056 314.341ZM62.0544 61.4181C134.713 -11.2404 300.168 36.4105 431.607 167.85C563.046 299.289 610.697 464.744 538.039 537.402C487.42 588.021 391.765 580.247 293.949 526.432C320.351 498.991 336.616 461.502 336.616 420.167C336.616 336.052 269.266 267.864 186.187 267.863C143.717 267.863 105.359 285.684 78.0056 314.341C19.7299 213.488 9.91302 113.56 62.0544 61.4181Z'
const VIEW = 600

/** The light goes once around in this long. */
const PERIOD_MS = 14_000
/** It moves slowly, so thirty frames a second is plenty. */
const FRAME_MS = 1000 / 30
/** Lit from the top-left to begin with, and for good under reduced motion. */
const START = -0.75 * Math.PI

/**
 * The iOS screen's numbers are points on a 240pt mark; here they are the
 * mark's own units, so the relief keeps its proportions at any drawn size.
 * A shadow's radius there is twice a Gaussian's deviation here.
 */
const POINT = VIEW / 240
/**
 * Pressed in, where the iOS mark is raised: the same relief with the light's
 * two edges swapped. The floor is darkest under the wall nearest the light
 * and lightens away from it. It is a step quieter than the iOS face (white
 * 0.12 to 0.045, highlight 0.28), since the mark is drawn far larger here.
 */
const FLOOR = { near: '#090909', far: '#171717' }
/** The wall nearest the light throws its shadow down onto the floor… */
const SHADE = { offset: 7 * POINT, blur: 3 * POINT, opacity: 0.85 }
/** …and the wall across from it faces the light and catches it. */
const HIGHLIGHT = { offset: 2.5 * POINT, blur: 1 * POINT, opacity: 0.18 }

/** Everything that turns with the light, for a light at `angle` (radians, 0 = from the right, clockwise). */
function lit(angle: number) {
  const x = Math.cos(angle)
  const y = Math.sin(angle)
  const n = (value: number) => value.toFixed(3)
  return {
    // The floor's gradient runs from the side nearest the light to the far side.
    gradient: { x1: n(0.5 + x / 2), y1: n(0.5 + y / 2), x2: n(0.5 - x / 2), y2: n(0.5 - y / 2) },
    // An inner shadow shows on the edge its offset points away from: the
    // shade on the edge nearest the light, the highlight on the one across.
    shade: { dx: n(-x * SHADE.offset), dy: n(-y * SHADE.offset) },
    highlight: { dx: n(x * HIGHLIGHT.offset), dy: n(y * HIGHLIGHT.offset) },
  }
}

function setAll(element: Element | null, attributes: Record<string, string>) {
  if (!element) return
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value)
}

/**
 * The Gamut mark pressed into the wizard cover's black: the iOS welcome
 * screen's mark, sunk where that one is raised. Near-black on black, read
 * only by the light across its edges, and that light circles it slowly. It
 * sits behind the orb crowd.
 *
 * `paused` holds the light where it is; `still` (reduced motion) keeps it at
 * the top-left.
 */
export function WelcomeDebossedMark({ paused = false, still = false }: { paused?: boolean; still?: boolean }) {
  const id = useId().replace(/:/g, '')
  const svgRef = useRef<SVGSVGElement>(null)
  const gradientRef = useRef<SVGLinearGradientElement>(null)
  const highlightRef = useRef<SVGFEOffsetElement>(null)
  const shadeRef = useRef<SVGFEOffsetElement>(null)
  /** Time the light has spent moving, so a pause resumes where it stopped. */
  const elapsed = useRef(0)

  useEffect(() => {
    const svg = svgRef.current
    if (!svg || still || paused) return
    let last = 0
    const tick = (now: number) => {
      // A few ms of slack: at 60Hz every second frame lands just under 33.3ms.
      if (last && now - last < FRAME_MS - 4) return
      if (last) elapsed.current += Math.min(now - last, 64)
      last = now
      const light = lit(START + ((elapsed.current % PERIOD_MS) / PERIOD_MS) * 2 * Math.PI)
      setAll(gradientRef.current, light.gradient)
      setAll(highlightRef.current, light.highlight)
      setAll(shadeRef.current, light.shade)
    }
    let unsubscribe: (() => void) | undefined
    const unobserve = observeOrbVisibility(svg, visible => {
      if (visible) unsubscribe ??= subscribeToFrames(tick)
      else {
        unsubscribe?.()
        unsubscribe = undefined
        last = 0
      }
    })
    return () => {
      unobserve()
      unsubscribe?.()
    }
  }, [still, paused])

  // What is drawn before the first frame, and all that reduced motion draws. The
  // light's own writes go to the DOM, which React leaves alone: these never change.
  const initial = lit(START)

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${VIEW} ${VIEW}`}
      aria-hidden="true"
      data-testid="wizard-debossed-mark"
      // The iOS mark is three-fifths of the screen's width, a little above centre.
      className="pointer-events-none absolute left-1/2 aspect-square -translate-x-1/2 -translate-y-1/2"
      style={{ top: '45.4%', width: 'min(60%, 26rem)' }}
    >
      <defs>
        <linearGradient ref={gradientRef} id={`${id}-face`} {...initial.gradient}>
          <stop offset="0" stopColor={FLOOR.near} />
          <stop offset="1" stopColor={FLOOR.far} />
        </linearGradient>
        <filter id={`${id}-relief`} colorInterpolationFilters="sRGB">
          <feOffset ref={shadeRef} in="SourceAlpha" {...initial.shade} result="shadeAt" />
          <feGaussianBlur in="shadeAt" stdDeviation={SHADE.blur} result="shadeSoft" />
          <feComposite in="SourceAlpha" in2="shadeSoft" operator="out" result="shadeEdge" />
          <feFlood floodColor="#000" floodOpacity={SHADE.opacity} result="shadeInk" />
          <feComposite in="shadeInk" in2="shadeEdge" operator="in" result="shade" />

          <feOffset ref={highlightRef} in="SourceAlpha" {...initial.highlight} result="highlightAt" />
          <feGaussianBlur in="highlightAt" stdDeviation={HIGHLIGHT.blur} result="highlightSoft" />
          <feComposite in="SourceAlpha" in2="highlightSoft" operator="out" result="highlightEdge" />
          <feFlood floodColor="#fff" floodOpacity={HIGHLIGHT.opacity} result="highlightInk" />
          <feComposite in="highlightInk" in2="highlightEdge" operator="in" result="highlight" />

          <feMerge>
            <feMergeNode in="SourceGraphic" />
            <feMergeNode in="shade" />
            <feMergeNode in="highlight" />
          </feMerge>
        </filter>
      </defs>
      <path d={MARK} fill={`url(#${id}-face)`} filter={`url(#${id}-relief)`} />
    </svg>
  )
}
