import { useSyncExternalStore } from 'react'

const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | undefined
let revision = 0

function tick() {
  revision++
  listeners.forEach(listener => listener())
}

function syncVisibility() {
  clearInterval(timer)
  timer = undefined
  if (!document.hidden) {
    tick()
    timer = setInterval(tick, 60_000)
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  if (listeners.size === 1) {
    document.addEventListener('visibilitychange', syncVisibility)
    syncVisibility()
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      clearInterval(timer)
      timer = undefined
      document.removeEventListener('visibilitychange', syncVisibility)
    }
  }
}

const snapshot = () => revision

/**
 * One clock for relative-time labels, stopped when unused or the page is
 * hidden. Only subscribers re-render. Format against Date.now() at render
 * time: a new activity timestamp must not wait for, or use the time of, the
 * previous clock tick. This clock never invalidates server data.
 */
export function useMinuteClock(): void {
  useSyncExternalStore(subscribe, snapshot, snapshot)
}
