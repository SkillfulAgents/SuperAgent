/**
 * One animation frame loop for every orb on screen. Each orb animates
 * continuously in most states (an idle glance, a sleeping breath), so a
 * sidebar of agents would otherwise run a loop apiece; here they share one,
 * which stops when nothing is subscribed. Read all geometry before any
 * subscriber writes styles, so pointer following cannot force a style flush
 * between each pair of avatars. Hidden documents explicitly stop the loop.
 *
 * While no orb needs smooth motion, paint at CALM_FPS: skipped frames write no
 * styles, so the GPU has nothing new to composite on high refresh displays.
 */

type Tick = (now: number) => void

export interface FrameOptions {
  measure?: Tick
  /** True while this orb's motion needs every display frame. */
  smooth?: () => boolean
}

export const CALM_FPS = 30
// Slack so a 60 Hz or 120 Hz display lands on every 2nd or 4th frame, not one later.
const CALM_FRAME_MS = 1000 / CALM_FPS - 2

const subscribers = new Map<Tick, FrameOptions>()
let frame = 0
let painted = 0

function run(now: number) {
  let smooth = false
  subscribers.forEach(options => { smooth ||= options.smooth?.() ?? false })
  if (smooth || now - painted >= CALM_FRAME_MS) {
    painted = now
    subscribers.forEach(options => options.measure?.(now))
    subscribers.forEach((_options, tick) => tick(now))
  }
  frame = subscribers.size && !document.hidden ? requestAnimationFrame(run) : 0
  if (!frame) painted = 0
}

function syncVisibility() {
  if (document.hidden && frame) {
    cancelAnimationFrame(frame)
    frame = 0
    painted = 0
  } else if (!document.hidden && !frame && subscribers.size) frame = requestAnimationFrame(run)
}

/** Call `tick` every painted frame until the returned function is called. */
export function subscribeToFrames(tick: Tick, options: FrameOptions = {}): () => void {
  subscribers.set(tick, options)
  if (subscribers.size === 1) document.addEventListener('visibilitychange', syncVisibility)
  syncVisibility()
  return () => {
    subscribers.delete(tick)
    if (!subscribers.size) {
      document.removeEventListener('visibilitychange', syncVisibility)
      if (frame) cancelAnimationFrame(frame)
      frame = 0
      painted = 0
    }
  }
}
