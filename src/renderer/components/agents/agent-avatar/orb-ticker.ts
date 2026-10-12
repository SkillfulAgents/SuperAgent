/**
 * One animation frame loop for every orb on screen. Each orb animates
 * continuously in most states (an idle glance, a sleeping breath), so a
 * sidebar of agents would otherwise run a loop apiece; here they share one,
 * which stops when nothing is subscribed. The browser pauses it in hidden
 * windows.
 */

type Tick = (now: number) => void

const subscribers = new Set<Tick>()
let frame = 0

function run(now: number) {
  subscribers.forEach(tick => tick(now))
  frame = subscribers.size ? requestAnimationFrame(run) : 0
}

/** Call `tick` every frame until the returned function is called. */
export function subscribeToFrames(tick: Tick): () => void {
  subscribers.add(tick)
  if (!frame) frame = requestAnimationFrame(run)
  return () => {
    subscribers.delete(tick)
    if (!subscribers.size && frame) {
      cancelAnimationFrame(frame)
      frame = 0
    }
  }
}
