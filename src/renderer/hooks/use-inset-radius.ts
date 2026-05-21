import { useEffect, useState } from 'react'
import { getPlatform, getOSVersion, isElectron } from '@renderer/lib/env'
import { useFullScreen } from './use-fullscreen'

const FALLBACK_RADIUS_PX = 16

function pickRadiusForOS(): number {
  if (!isElectron()) return FALLBACK_RADIUS_PX

  const platform = getPlatform()
  const version = getOSVersion() ?? ''
  const major = parseInt(version.split('.')[0] ?? '', 10)

  if (platform === 'darwin') {
    // macOS 26 (Tahoe) ships noticeably larger window corners than 15 (Sequoia) and earlier.
    if (Number.isFinite(major) && major >= 26) return 16
    return 7
  }

  if (platform === 'win32') {
    // Windows 11 has 8px window corners; Windows 10 is square.
    if (Number.isFinite(major) && major >= 10) {
      const build = parseInt(version.split('.')[2] ?? '', 10)
      if (Number.isFinite(build) && build >= 22000) return 5
    }
    return 0
  }

  return FALLBACK_RADIUS_PX
}

/**
 * Sets the `--inset-radius` CSS variable on `<html>` to a value that nests
 * cleanly inside the OS window's outer corner radius. Falls back to a sensible
 * default in browsers, fullscreen, and maximized states (where there's no
 * outer rounded corner to match).
 */
export function useInsetRadius(): void {
  const isFullScreen = useFullScreen()
  const [isMaximized, setIsMaximized] = useState(false)

  useEffect(() => {
    if (!isElectron() || getPlatform() !== 'win32') return
    window.electronAPI?.getWindowMaximizedState().then(setIsMaximized)
    window.electronAPI?.onWindowMaximizedChange(setIsMaximized)
    return () => {
      window.electronAPI?.removeWindowMaximizedChange()
    }
  }, [])

  useEffect(() => {
    const radius = isFullScreen || isMaximized ? FALLBACK_RADIUS_PX : pickRadiusForOS()
    document.documentElement.style.setProperty('--inset-radius', `${radius}px`)
  }, [isFullScreen, isMaximized])
}
