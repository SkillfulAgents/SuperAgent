import { ambientAnimationAllowed, subscribeToAmbientAnimationAllowed } from './ambient-frames'

/**
 * Holds every animation the page does not drive from script while ambient
 * animation is not allowed (the document is hidden, or its window is not the
 * one in use): looping CSS animations (spinners, pulses, shimmers, tickers),
 * looping Web Animations, SVG `<animate>` loops, and muted looping videos.
 * They resume where they stopped. Script-driven loops keep the same rule by
 * subscribing to ambient-frames.ts; this covers the rest in one place, so a
 * new `animate-spin` needs nothing.
 *
 * Only animation that loops (or runs for ten seconds or more) is held. A
 * transition or an entrance plays once and ends, and holding one would leave a
 * dialog or a toast that opened while the window was in the background
 * invisible at its first keyframe.
 *
 * A held animation is slowed to a playback rate of zero, not paused: pause()
 * and play() take an animation out of the hands of its `animation-play-state`
 * for good, and a ticker that pauses under the pointer would never do so again.
 * At rate zero it asks for no frames either.
 *
 * It looks when the window goes into the background and at each CSS animation
 * that starts after that, and at no other time: a window held all day does no
 * work for it. A Web Animation, SVG loop or video that first appears while the
 * window is in the background therefore runs until the next time.
 *
 * Installed once by each renderer entry point. It reaches this document only:
 * a dashboard's or widget's frame animates by its own rules.
 */

/** A finite animation this long is ambient too: it outlasts any entrance. */
const LONG_MS = 10_000

function isAmbient(animation: Animation): boolean {
  const timing = animation.effect?.getComputedTiming()
  if (!timing) return false
  return timing.iterations === Infinity || Number(timing.activeDuration) >= LONG_MS
}

const SMIL = 'animate, animateTransform, animateMotion, set'

/** Whether what an animation moves is still in the document. */
function connected(animation: Animation): boolean {
  return (animation.effect as KeyframeEffect | null)?.target?.isConnected !== false
}

export function installAmbientAnimationPause(): () => void {
  /** Each held animation, and the rate to give it back. */
  const animations = new Map<Animation, number>()
  const drawings = new Set<SVGSVGElement>()
  const videos = new Set<HTMLVideoElement>()
  let holding = false

  const holdAnimations = (found: Animation[]) => {
    for (const animation of found) {
      if (animation.playbackRate === 0 || animation.playState !== 'running' || !isAmbient(animation)) continue
      animations.set(animation, animation.playbackRate)
      animation.playbackRate = 0
    }
  }

  const hold = () => {
    holdAnimations(document.getAnimations?.() ?? [])
    for (const svg of document.querySelectorAll<SVGSVGElement>('svg')) {
      // Only an outermost <svg> has a timeline of its own.
      if (svg.ownerSVGElement || svg.animationsPaused?.() !== false || !svg.querySelector(SMIL)) continue
      svg.pauseAnimations()
      drawings.add(svg)
    }
    for (const video of document.querySelectorAll('video')) {
      // Muted and looping: decoration, not something being watched or heard.
      if (video.paused || !video.loop || !video.muted) continue
      video.pause()
      videos.add(video)
    }
  }

  const release = () => {
    // One the page's own CSS paused meanwhile stays paused: its rule still has it.
    animations.forEach((rate, animation) => {
      if (animation.playbackRate === 0) animation.playbackRate = rate
    })
    for (const svg of drawings) if (svg.isConnected) svg.unpauseAnimations()
    for (const video of videos) if (video.isConnected) void video.play().catch(() => {})
    animations.clear()
    drawings.clear()
    videos.clear()
  }

  // A loop that starts while held. Only the element it started on is looked at: a reply
  // streaming in the background starts an animation a word, and none is worth a scan of the page.
  const onAnimationStart = (event: AnimationEvent) => {
    const target = event.target
    if (!(target instanceof Element)) return
    // What was held and has since left the page (a spinner that unmounted) is let go.
    if (animations.size > 256) for (const animation of animations.keys()) if (!connected(animation)) animations.delete(animation)
    // An animation on ::before or ::after is listed only with the subtree.
    const found = target.getAnimations?.({ subtree: Boolean(event.pseudoElement) }) ?? []
    holdAnimations(found.filter((animation) => (animation.effect as KeyframeEffect | null)?.target === target))
  }

  const sync = () => {
    const allowed = ambientAnimationAllowed()
    if (allowed === !holding) return
    holding = !allowed
    if (allowed) {
      document.removeEventListener('animationstart', onAnimationStart, true)
      release()
    } else {
      document.addEventListener('animationstart', onAnimationStart, true)
      hold()
    }
  }

  const unsubscribe = subscribeToAmbientAnimationAllowed(sync)
  sync()
  return () => {
    unsubscribe()
    if (!holding) return
    holding = false
    document.removeEventListener('animationstart', onAnimationStart, true)
    release()
  }
}
