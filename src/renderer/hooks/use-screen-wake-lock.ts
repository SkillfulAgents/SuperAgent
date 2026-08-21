import { useEffect, useRef } from 'react'

/**
 * Holds a screen Wake Lock while `active` is true so the phone won't sleep
 * mid-session. Scoped to the installed PWA only:
 *  - Electron has its own keep-awake (powerSaveBlocker via the Keep Awake
 *    setting), so we skip it there.
 *  - In a plain browser tab we stay out of the way; the lock only engages once
 *    the app is launched from the Home Screen.
 *
 * iOS releases the lock whenever the page is hidden (screen off / app
 * backgrounded), so we re-acquire on `visibilitychange`. The lock is released
 * when `active` flips to false or the component unmounts — i.e. when the
 * session finishes working — letting normal auto-sleep resume.
 */

type WakeLockSentinelLike = {
  release: () => Promise<void>
  addEventListener: (type: 'release', listener: () => void) => void
}

function isStandalonePWA(): boolean {
  if (typeof window === 'undefined') return false
  // iOS Safari exposes navigator.standalone; the spec-standard signal is the
  // standalone display-mode media query (Android/Chromium + modern iOS).
  return (
    window.matchMedia?.('(display-mode: standalone)').matches === true ||
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  )
}

export function useScreenWakeLock(active: boolean): void {
  const sentinelRef = useRef<WakeLockSentinelLike | null>(null)

  useEffect(() => {
    const wakeLock = (navigator as Navigator & {
      wakeLock?: { request: (type: 'screen') => Promise<WakeLockSentinelLike> }
    }).wakeLock

    // Web PWA only, where the API exists, and only while there's work to do.
    if (window.electronAPI || !wakeLock || !isStandalonePWA() || !active) return

    let cancelled = false

    const acquire = async () => {
      if (sentinelRef.current || document.visibilityState !== 'visible') return
      try {
        const sentinel = await wakeLock.request('screen')
        if (cancelled) {
          sentinel.release().catch(() => {})
          return
        }
        sentinelRef.current = sentinel
        // The lock can be released by the platform (tab hidden, low battery);
        // clear our ref so visibilitychange can re-acquire it.
        sentinel.addEventListener('release', () => {
          if (sentinelRef.current === sentinel) sentinelRef.current = null
        })
      } catch {
        // request() rejects when not visible / battery-saver — retry on visibility.
      }
    }

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') acquire()
    }

    acquire()
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisibilityChange)
      const sentinel = sentinelRef.current
      sentinelRef.current = null
      sentinel?.release().catch(() => {})
    }
  }, [active])
}
