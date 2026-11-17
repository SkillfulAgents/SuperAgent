/**
 * Whether this window is the one the person is using: it, or a frame inside
 * it, has the keyboard focus. A window left open behind another app, or beside
 * it on a second display, is not hidden (`document.hidden` stays false unless
 * it is minimised or fully covered), so decorative animation that only stops
 * for a hidden document runs all day in an app nobody is looking at. Such
 * animation holds its frame while the window is inactive instead.
 *
 * `focus` and `blur` on the window say most of it, but not all: once focus is
 * inside an embedded frame (a dashboard, a widget), leaving the app fires
 * nothing on this window. A slow poll while anyone is subscribed covers that.
 */

type Listener = (active: boolean) => void

const POLL_MS = 1000
const listeners = new Set<Listener>()
let active = true
let poll: number | undefined

function read(): boolean {
  return typeof document.hasFocus !== 'function' || document.hasFocus()
}

function sync() {
  const next = read()
  if (next === active) return
  active = next
  listeners.forEach((listener) => listener(next))
}

export function isWindowActive(): boolean {
  return listeners.size ? active : read()
}

/** Call `listener` whenever the window becomes active or inactive, until the returned function is called. */
export function subscribeToWindowActive(listener: Listener): () => void {
  if (listeners.size === 0) {
    active = read()
    window.addEventListener('focus', sync)
    window.addEventListener('blur', sync)
    poll = window.setInterval(sync, POLL_MS)
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      window.removeEventListener('focus', sync)
      window.removeEventListener('blur', sync)
      window.clearInterval(poll)
      poll = undefined
    }
  }
}
