import { useSyncExternalStore } from 'react'
import { isWindowActive, subscribeToWindowActive } from './window-active'

/**
 * The frame loop for ambient animation: motion that runs by itself, for as
 * long as its component is on screen (an avatar's glance, a backdrop's drift,
 * a level meter), as opposed to a transition that plays once and ends.
 * Subscribing here instead of calling requestAnimationFrame is how a loop
 * keeps the rules in docs/animations.md.
 *
 * Every subscriber says what kind of animation it is, because what it may do
 * in a window that is shown but not the one in use (left open behind another
 * app, or beside it on a second display) depends on what it is for:
 *
 * - `decoration` carries no information (a backdrop, an idle flourish). In the
 *   background it holds its frame. It is painted once when it joins, so it is
 *   still and never blank; one whose picture a resize clears repaints it there
 *   and then, as it has to in a held window anyway.
 * - `status` shows a state someone may glance over to read (an agent's avatar,
 *   an activity indicator). In the background it runs on the slow clock, once
 *   a second, so what it shows cannot go stale whatever its component forgot,
 *   and `wakeAmbientFrames()` gives it a moment at full rate when its state
 *   changes, so the change is drawn properly and not a second late in one step.
 * - `live` follows something the person is doing right now that carries on
 *   without the window's focus (a voice conversation, audio playing). It keeps
 *   its rate, and subscribes only while that activity runs.
 *
 * Nothing runs while the document is hidden. Only decoration is ever stopped
 * in a shown window: stopping the clock for everything left avatars on the
 * state before last and canvases blank, each component in its own way.
 *
 * Each subscriber paints at a stated rate, 60 times a second at most and 30
 * where the motion is slow: requestAnimationFrame follows the display, and
 * every painted frame makes the whole window composite again. One loop serves
 * all of them on the same beats, so a page of animations composites as often
 * as its fastest one, and all geometry is read (`measure`) before anything
 * writes styles (`tick`).
 */

type Tick = (now: number) => void
export type AmbientKind = 'decoration' | 'status' | 'live'
export type AmbientFps = 30 | 60

export interface AmbientFrameOptions {
  /** What the animation is for, which decides what it does in a window that is not in use. */
  kind: AmbientKind
  /** Called before any subscriber's `tick` in a frame: read layout here. */
  measure?: Tick
  /**
   * Paints a second: 60 for motion that follows input or moves fast, 30 for slow drift.
   * A function is asked on every frame, for an animation whose pace changes with its state.
   */
  fps?: AmbientFps | (() => AmbientFps)
}

interface Subscriber {
  kind: AmbientKind
  measure?: Tick
  fps: AmbientFps | (() => AmbientFps)
  /** Not painted yet: it takes the next frame whatever the clock. */
  fresh: boolean
  /** A `status` subscriber keeps its full rate in the background until then. */
  awakeUntil: number
  /** This frame's pace, and whether it takes this frame. */
  pace: AmbientFps | 'slow' | 'hold'
  due: boolean
}

/** The slow clock: how often a window that is shown but not in use repaints its status animations. */
export const AMBIENT_SLOW_MS = 1000
/**
 * A display frame this close before a beat takes it: frames arrive a little
 * early as often as late. Beats are kept on a fixed grid and not measured from
 * the last paint, so the rate holds on a display of any speed all the same: a
 * 75 Hz one paints four frames in five, not all of them.
 */
const EARLY_MS = 4

const subscribers = new Map<Tick, Subscriber>()
const allowedListeners = new Set<() => void>()
let frame = 0
/** Inside a frame, and whether something in it changed who wants the next one. */
let running = false
let changed = false
let timer: number | undefined
let shown = true
let windowActive = true
let watchers = 0
let unsubscribeWindowActive: (() => void) | undefined
let nextBeat = -Infinity
let nextSlowBeat = -Infinity
let beat = 0

function paceOf(subscriber: Subscriber, now: number): AmbientFps | 'slow' | 'hold' {
  const full =
    windowActive || subscriber.kind === 'live' || (subscriber.kind === 'status' && now < subscriber.awakeUntil)
  if (!full) return subscriber.kind === 'status' ? 'slow' : 'hold'
  return typeof subscriber.fps === 'function' ? subscriber.fps() : subscriber.fps
}

/** Whether the grid's beat at `next`, `interval` apart, falls on the frame at `now`. A clock that jumped starts a new grid. */
function onBeat(now: number, next: number, interval: number): boolean {
  return now >= next - EARLY_MS || next - now > interval
}

function advance(now: number, next: number, interval: number): number {
  // Behind by more than a beat (the loop was stopped, or a frame was very late): start again from here.
  return now - next < interval && next <= now + interval ? next + interval : now + interval
}

/** One subscriber's failure is its own: drop it and report, and everyone else keeps their frames. */
function failed(tick: Tick, error: unknown) {
  subscribers.delete(tick)
  window.setTimeout(() => {
    throw error
  })
}

function run(now: number) {
  frame = 0
  running = true
  changed = false
  let fastest: 0 | AmbientFps = 0
  let slow = false
  subscribers.forEach((subscriber) => {
    try {
      subscriber.pace = paceOf(subscriber, now)
    } catch {
      subscriber.pace = 60
    }
    if (subscriber.pace === 'slow') slow = true
    else if (subscriber.pace !== 'hold' && subscriber.pace > fastest) fastest = subscriber.pace
  })

  let fastBeat = false
  let half = false
  if (fastest) {
    const interval = 1000 / fastest
    if (onBeat(now, nextBeat, interval)) {
      fastBeat = true
      nextBeat = advance(now, nextBeat, interval)
      beat++
      // On a 60-a-second beat, the 30-a-second subscribers take every other one, together.
      half = fastest === 60 && beat % 2 === 1
    }
  }
  let slowBeat = false
  if (slow && onBeat(now, nextSlowBeat, AMBIENT_SLOW_MS)) {
    slowBeat = true
    nextSlowBeat = now + AMBIENT_SLOW_MS
  }

  subscribers.forEach((subscriber, tick) => {
    subscriber.due =
      subscriber.fresh ||
      (subscriber.pace === 'slow'
        ? slowBeat
        : subscriber.pace !== 'hold' && fastBeat && (subscriber.pace === 60 || !half))
    if (!subscriber.due || !subscriber.measure) return
    try {
      subscriber.measure(now)
    } catch (error) {
      failed(tick, error)
    }
  })
  subscribers.forEach((subscriber, tick) => {
    if (!subscriber.due) return
    subscriber.fresh = false
    try {
      tick(now)
    } catch (error) {
      failed(tick, error)
    }
  })

  running = false
  if (!shown || subscribers.size === 0) return
  // A subscriber that joined, left or woke inside this frame: the next one works it out.
  if (fastest || changed) frame = requestAnimationFrame(run)
  else if (slow) {
    // Nothing wants frames until the slow clock's next beat: ask for none in between.
    timer = window.setTimeout(() => {
      timer = undefined
      if (!frame && shown && subscribers.size > 0) frame = requestAnimationFrame(run)
    }, Math.max(0, nextSlowBeat - now))
  }
}

/** Something changed (who is subscribed, the window, a wake): take the next frame and work it out there. */
function syncLoop() {
  // From inside a frame (a tick that subscribes, unsubscribes or wakes): the frame's own end
  // decides, or two chains of frames would run from here on.
  if (running) {
    changed = true
    return
  }
  if (shown && subscribers.size > 0) {
    if (frame) return
    window.clearTimeout(timer)
    timer = undefined
    frame = requestAnimationFrame(run)
    return
  }
  if (frame) cancelAnimationFrame(frame)
  frame = 0
  window.clearTimeout(timer)
  timer = undefined
}

function onChange() {
  const wasAllowed = shown && windowActive
  shown = !document.hidden
  windowActive = isWindowActive()
  syncLoop()
  if ((shown && windowActive) !== wasAllowed) allowedListeners.forEach((listener) => listener())
}

function watch(): () => void {
  if (watchers++ === 0) {
    document.addEventListener('visibilitychange', onChange)
    unsubscribeWindowActive = subscribeToWindowActive(onChange)
    shown = !document.hidden
    windowActive = isWindowActive()
  }
  return () => {
    if (--watchers > 0) return
    document.removeEventListener('visibilitychange', onChange)
    unsubscribeWindowActive?.()
    unsubscribeWindowActive = undefined
  }
}

/**
 * Whether decoration may run at its full rate now: the document is shown and
 * its window is the one in use. What is not driven from this loop (looping
 * CSS, a carousel's timer) holds still while this is false.
 */
export function ambientAnimationAllowed(): boolean {
  return watchers > 0 ? shown && windowActive : !document.hidden && isWindowActive()
}

/** Call `listener` whenever `ambientAnimationAllowed()` changes, until the returned function is called. */
export function subscribeToAmbientAnimationAllowed(listener: () => void): () => void {
  const unwatch = watch()
  allowedListeners.add(listener)
  return () => {
    allowedListeners.delete(listener)
    unwatch()
  }
}

/** `ambientAnimationAllowed()` as state, for decoration driven by a timer or by rendering. */
export function useAmbientAnimationAllowed(): boolean {
  return useSyncExternalStore(subscribeToAmbientAnimationAllowed, ambientAnimationAllowed, () => true)
}

/**
 * Call `tick` on animation frames until the returned function is called: at
 * `fps` while its kind allows the full rate, held or on the slow clock
 * otherwise, never while the document is hidden, and once straight away so it
 * is never unpainted. `now` is the frame's timestamp. Calls can be far apart
 * (a held window, the slow clock, a hidden document), so a tick that integrates
 * time clamps its own step.
 */
export function subscribeToAmbientFrames(tick: Tick, { kind, measure, fps = 60 }: AmbientFrameOptions): () => void {
  const unwatch = watch()
  subscribers.set(tick, { kind, measure, fps, fresh: true, awakeUntil: -Infinity, pace: 'slow', due: false })
  syncLoop()
  let subscribed = true
  return () => {
    if (!subscribed) return
    subscribed = false
    subscribers.delete(tick)
    syncLoop()
    unwatch()
  }
}

/**
 * A `status` subscriber's state just changed: give it `ms` at its full rate
 * even in a window that is not in use, so the change plays out and is not
 * shown a second late.
 */
export function wakeAmbientFrames(tick: Tick, ms: number): void {
  const subscriber = subscribers.get(tick)
  if (!subscriber) return
  subscriber.awakeUntil = performance.now() + ms
  syncLoop()
}
