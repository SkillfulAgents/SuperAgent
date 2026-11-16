import { useId } from 'react'

/** The Gamut logomark, as in the app icon's source (build/icon.icon/Assets/gamut_logomark_white.svg). */
const MARK = 'M78.0056 314.341C100.937 354.026 131.37 393.855 168.486 430.971C208.357 470.841 251.358 503 293.949 526.432C266.624 554.832 228.44 572.471 186.187 572.471C103.108 572.471 35.7585 504.282 35.7585 420.167C35.7586 379.052 51.851 341.742 78.0056 314.341ZM62.0544 61.4181C134.713 -11.2404 300.168 36.4105 431.607 167.85C563.046 299.289 610.697 464.744 538.039 537.402C487.42 588.021 391.765 580.247 293.949 526.432C320.351 498.991 336.616 461.502 336.616 420.167C336.616 336.052 269.266 267.864 186.187 267.863C143.717 267.863 105.359 285.684 78.0056 314.341C19.7299 213.488 9.91302 113.56 62.0544 61.4181Z'
const VIEW = 600

/**
 * The iOS screen's numbers are points on a 240pt mark; here they are the
 * mark's own units, so the relief keeps its proportions at any drawn size.
 * A shadow's radius there is twice a Gaussian's deviation here.
 */
const POINT = VIEW / 240
/**
 * The floor of the mark: lightest at the upper left, darkest at the lower
 * right. Far fainter than the iOS face (white 0.12 to 0.045, highlight
 * 0.28): here it is drawn much larger and is meant to be barely there.
 */
const FLOOR = { light: '#0d0d0d', dark: '#050505' }
/** The upper-left edges carry a thin line of light… */
const HIGHLIGHT = { offset: 2.5 * POINT, blur: 1 * POINT, opacity: 0.08 }
/** …and the lower-right edges fall away into the black. */
const SHADE = { offset: 7 * POINT, blur: 3 * POINT, opacity: 0.85 }

/**
 * The one angle the relief is drawn at: the unit vector from the lit edges
 * toward the shaded ones (down and to the right). The iOS mark's light
 * circles; this one holds still, so it reads the same way at every moment.
 */
const TOWARD_SHADE = { x: Math.SQRT1_2, y: Math.SQRT1_2 }

const n = (value: number) => value.toFixed(3)
const GRADIENT = {
  x1: n(0.5 - TOWARD_SHADE.x / 2), y1: n(0.5 - TOWARD_SHADE.y / 2),
  x2: n(0.5 + TOWARD_SHADE.x / 2), y2: n(0.5 + TOWARD_SHADE.y / 2),
}
// An inner shadow shows on the edge its offset points away from.
const HIGHLIGHT_OFFSET = { dx: n(TOWARD_SHADE.x * HIGHLIGHT.offset), dy: n(TOWARD_SHADE.y * HIGHLIGHT.offset) }
const SHADE_OFFSET = { dx: n(-TOWARD_SHADE.x * SHADE.offset), dy: n(-TOWARD_SHADE.y * SHADE.offset) }

/**
 * The Gamut mark set into the wizard cover's black, behind the orb crowd:
 * the iOS welcome screen's mark, near-black on black and read only by the
 * light along its edges. Still, at one angle.
 */
export function WelcomeDebossedMark() {
  const id = useId().replace(/:/g, '')
  return (
    <svg
      viewBox={`0 0 ${VIEW} ${VIEW}`}
      aria-hidden="true"
      data-testid="wizard-debossed-mark"
      // The iOS mark is three-fifths of the screen's width, a little above centre.
      className="pointer-events-none absolute left-1/2 aspect-square -translate-x-1/2 -translate-y-1/2"
      style={{ top: '45.4%', width: 'min(60%, 26rem)' }}
    >
      <defs>
        <linearGradient id={`${id}-floor`} {...GRADIENT}>
          <stop offset="0" stopColor={FLOOR.light} />
          <stop offset="1" stopColor={FLOOR.dark} />
        </linearGradient>
        <filter id={`${id}-relief`} colorInterpolationFilters="sRGB">
          <feOffset in="SourceAlpha" {...SHADE_OFFSET} result="shadeAt" />
          <feGaussianBlur in="shadeAt" stdDeviation={SHADE.blur} result="shadeSoft" />
          <feComposite in="SourceAlpha" in2="shadeSoft" operator="out" result="shadeEdge" />
          <feFlood floodColor="#000" floodOpacity={SHADE.opacity} result="shadeInk" />
          <feComposite in="shadeInk" in2="shadeEdge" operator="in" result="shade" />

          <feOffset in="SourceAlpha" {...HIGHLIGHT_OFFSET} result="highlightAt" />
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
      <path d={MARK} fill={`url(#${id}-floor)`} filter={`url(#${id}-relief)`} />
    </svg>
  )
}
