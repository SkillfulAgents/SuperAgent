/**
 * The "working" animation, from the "Working — the face as typing dots"
 * exploration's "Become the dots": the face slides to the centre, the body
 * shrinks away, and the face becomes the middle of three typing dots — small
 * copies of the shape bouncing in a typing rhythm. They keep typing for as
 * long as the agent works; when it stops, the body regrows around them with a
 * little overshoot, the face slides back out, and blinks.
 *
 * A pure function of time, so a frame can be computed for any moment and the
 * timing tested without a browser.
 */

/** One loop, seconds. */
export const DOTS_CYCLE = 5.6
/** From here the dots gather back and the body regrows: where stopping work skips to. */
export const DOTS_GATHER = 4.0
/** The dots are out and typing from here… */
export const TYPING_FROM = 1.45
/** …and while work goes on they repeat this stretch: four typing beats of 0.625s, so the bounce runs on unbroken. */
export const TYPING_LOOP = 2.5

/**
 * Where in the cycle to show `elapsed` seconds into work: the intro once,
 * then the typing stretch on repeat — the avatar only comes back when work
 * stops, when the gather and regrow play from DOTS_GATHER.
 */
export function workingPosition(elapsed: number): number {
  return elapsed < TYPING_FROM ? elapsed : TYPING_FROM + ((elapsed - TYPING_FROM) % TYPING_LOOP)
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x))
const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const segment = (x: number, a: number, b: number) => clamp01((x - a) / (b - a))
const easeInOut = (x: number) => {
  const t = clamp01(x)
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2
}
/** Ease out with overshoot. */
const back = (x: number) => {
  const t = clamp01(x)
  return 1 + 2.70158 * (t - 1) ** 3 + 1.70158 * (t - 1) ** 2
}
const bump = (x: number, centre: number, width: number) => Math.max(0, 1 - Math.abs(x - centre) / width)

/** Typing bounce for dot `i`: each dot hops in turn, rising `amplitude` px. */
function typing(x: number, i: number, amplitude: number): number {
  const u = (((x * 1.6 - i * 0.16) % 1) + 1) % 1
  return u < 0.42 ? -amplitude * Math.sin((Math.PI * u) / 0.42) : 0
}

// Dot geometry in design units (px on a 150px orb): size, centre-to-centre
// spacing, and bounce height. The design spaces them 38 apart; 35 sits them
// a touch closer.
const DOT = 26
const DOT_GAP = 35
const DOT_BOUNCE = 10

// The sidebar's 27px orb gets 7px dots: relatively larger than the design's
// 150px proportions, so they stay legible, without crowding the row.
const SIDEBAR_ORB = 27
const SIDEBAR_DOT = 7

/**
 * Px per design unit for the dots: the line through the sidebar size (7px
 * dots on a 27px orb) and the design's own (26-unit dots on a 150px orb).
 */
export function dotUnit(diameter: number): number {
  const small = SIDEBAR_DOT / DOT
  return Math.max(0.2, small + ((diameter - SIDEBAR_ORB) * (1 - small)) / (150 - SIDEBAR_ORB))
}

export interface DotsFrame {
  /** Face distance from the centre, 0…1 (see ShapeGaze). */
  distance: number
  faceOpacity: number
  /** Scale and opacity of the whole body. */
  scale: number
  opacity: number
  /** Face lid: 1 open, 0.1 shut. */
  blink: number
  /** Dot centres relative to the orb's centre, px. */
  dots: { x: number; y: number; size: number; opacity: number }[]
}

/** The frame `x` seconds into a cycle, for an orb `diameter` px across. */
export function becomeTheDots(x: number, diameter: number): DotsFrame {
  const unit = dotUnit(diameter)
  const faceSize = diameter * 0.5
  const dot = DOT * unit
  const gap = DOT_GAP * unit
  const amplitude = DOT_BOUNCE * unit
  const frame: DotsFrame = { distance: 1, faceOpacity: 1, scale: 1, opacity: 1, blink: 1, dots: [] }

  if (x < 0.5) {
    // The face slides to the centre.
    frame.distance = lerp(1, 0, easeInOut(segment(x, 0, 0.5)))
  } else if (x < 5.0) {
    frame.distance = 0
    frame.faceOpacity = 0
    const shrink = easeInOut(segment(x, 0.5, 1.1))
    if (x < 4.4) {
      frame.scale = lerp(1, 0.2, shrink)
      frame.opacity = 1 - segment(shrink, 0.55, 1)
    } else {
      frame.scale = lerp(0.2, 1, back(segment(x, 4.4, 5.0)))
      frame.opacity = segment(x, 4.4, 4.6)
    }
    // The middle dot is the face, shrinking to a dot and growing back.
    const middle = x < 4.4 ? lerp(faceSize, dot, shrink) : lerp(dot, faceSize, easeInOut(segment(x, 4.4, 5.0)))
    const spread = x < DOTS_GATHER ? back(segment(x, 1.1, 1.45)) : 1 - easeInOut(segment(x, DOTS_GATHER, 4.4))
    const bouncing = x > 1.45 && x < DOTS_GATHER
    ;[-1, 0, 1].forEach((side, i) => {
      frame.dots.push({
        x: side * gap * spread,
        y: bouncing ? typing(x, i, amplitude) : 0,
        size: side === 0 ? middle : dot,
        opacity: side === 0 ? 1 : clamp01(spread * 3),
      })
    })
  } else {
    // The face slides back out, and blinks.
    frame.distance = lerp(0, 1, easeInOut(segment(x, 5.0, 5.5)))
    frame.blink = 1 - 0.9 * bump(x, 5.3, 0.09)
  }
  return frame
}
