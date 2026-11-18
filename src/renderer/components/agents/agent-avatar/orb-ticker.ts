/**
 * One animation frame loop for every orb on screen. Each orb animates
 * continuously in most states (an idle glance, a sleeping breath), so a
 * sidebar of agents would otherwise run a loop apiece; here they share one,
 * which stops when nothing is subscribed. Read all geometry before any
 * subscriber writes styles, so pointer following cannot force a style flush
 * between each pair of avatars. Hidden documents explicitly stop the loop.
 */

type Tick = (now: number) => void

const subscribers = new Map<Tick, Tick | undefined>()
let frame = 0

function run(now: number) {
  subscribers.forEach(measure => measure?.(now))
  subscribers.forEach((_measure, tick) => tick(now))
  frame = subscribers.size && !document.hidden ? requestAnimationFrame(run) : 0
}

function syncVisibility() {
  if (document.hidden && frame) {
    cancelAnimationFrame(frame)
    frame = 0
  } else if (!document.hidden && !frame && subscribers.size) frame = requestAnimationFrame(run)
}

/** Call `tick` every frame until the returned function is called. */
export function subscribeToFrames(tick: Tick, measure?: Tick): () => void {
  subscribers.set(tick, measure)
  if (subscribers.size === 1) document.addEventListener('visibilitychange', syncVisibility)
  syncVisibility()
  return () => {
    subscribers.delete(tick)
    if (!subscribers.size) {
      document.removeEventListener('visibilitychange', syncVisibility)
      if (frame) cancelAnimationFrame(frame)
      frame = 0
    }
  }
}
