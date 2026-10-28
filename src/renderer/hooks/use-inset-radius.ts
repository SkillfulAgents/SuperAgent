import { useEffect, useState } from 'react'
import { getPlatform, getOSVersion, isElectron } from '@renderer/lib/env'
import { useFullScreen } from './use-fullscreen'

const FALLBACK_RADIUS_PX = 16

// The canvas sits this far inside the window (SidebarInset's m-2), so to share
// the window corner's centre its radius is the window's minus this gap.
const INSET_GAP_PX = 8
// The main window's corner on macOS 26 (Tahoe), matched by eye: Apple
// publishes no value, and it varies with the window's chrome.
const TAHOE_WINDOW_RADIUS_PX = 18
// macOS draws continuous corners: the curve eases in from the straight edge
// instead of starting as a full circular arc, so it runs further along each
// edge than a circle of the same apparent size. The canvas follows with a
// superellipse (k=1 is a circle, 2 a squircle, higher squarer), spread over
// this multiple of the circular radius above so its apex sits in the same
// place: a k=2 squircle reaches the corner's diagonal like a circle of about
// 0.54 of its radius.
const TAHOE_CORNER_SHAPE = 'superellipse(2)'
const TAHOE_CONTINUOUS_SPREAD = 1.85

interface InsetCorner {
  radius: number
  /** A CSS `corner-shape`; round when absent. */
  shape?: string
}

function pickCornerForOS(): InsetCorner {
  if (!isElectron()) return { radius: FALLBACK_RADIUS_PX }

  const platform = getPlatform()
  const version = getOSVersion() ?? ''
  const major = parseInt(version.split('.')[0] ?? '', 10)

  if (platform === 'darwin') {
    // macOS 26 (Tahoe) ships noticeably larger window corners than 15 (Sequoia) and earlier.
    if (Number.isFinite(major) && major >= 26) {
      return {
        radius: Math.round((TAHOE_WINDOW_RADIUS_PX - INSET_GAP_PX) * TAHOE_CONTINUOUS_SPREAD),
        shape: TAHOE_CORNER_SHAPE,
      }
    }
    return { radius: 7 }
  }

  if (platform === 'win32') {
    // Windows 11 has 8px window corners; Windows 10 is square.
    if (Number.isFinite(major) && major >= 10) {
      const build = parseInt(version.split('.')[2] ?? '', 10)
      if (Number.isFinite(build) && build >= 22000) return { radius: 5 }
    }
    return { radius: 0 }
  }

  return { radius: FALLBACK_RADIUS_PX }
}

/**
 * Sets the `--inset-radius` and `--inset-corner-shape` CSS variables on
 * `<html>` to a corner that nests cleanly inside the OS window's outer corner.
 * Falls back to a sensible round default in browsers, fullscreen, and
 * maximized states (where there's no outer rounded corner to match).
 */
export function useInsetRadius(): void {
  const isFullScreen = useFullScreen()
  const [isMaximized, setIsMaximized] = useState(false)

  useEffect(() => {
    if (!isElectron() || getPlatform() !== 'win32') return
    window.electronAPI?.getWindowMaximizedState().then(setIsMaximized)
    // Capture the per-listener unsubscribe — WindowControls also subscribes to
    // window-maximized-change, so a channel-wide reset here would kill its listener.
    const unsubscribe = window.electronAPI?.onWindowMaximizedChange(setIsMaximized)
    return () => {
      unsubscribe?.()
    }
  }, [])

  useEffect(() => {
    const { radius, shape = 'round' } = isFullScreen || isMaximized ? { radius: FALLBACK_RADIUS_PX } : pickCornerForOS()
    document.documentElement.style.setProperty('--inset-radius', `${radius}px`)
    document.documentElement.style.setProperty('--inset-corner-shape', shape)
  }, [isFullScreen, isMaximized])
}
