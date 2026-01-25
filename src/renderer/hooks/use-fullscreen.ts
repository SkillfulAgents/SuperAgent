import { useState, useEffect } from 'react'
import { isElectron } from '@renderer/lib/env'

/**
 * Hook to track whether the Electron window is in full screen mode.
 * Returns false for web (non-Electron) environment.
 */
export function useFullScreen(): boolean {
  const [isFullScreen, setIsFullScreen] = useState(false)

  useEffect(() => {
    if (!isElectron() || !window.electronAPI) {
      return
    }

    // Get initial state
    window.electronAPI.getFullScreenState().then(setIsFullScreen)

    // Listen for changes
    window.electronAPI.onFullScreenChange(setIsFullScreen)

    return () => {
      window.electronAPI?.removeFullScreenChange()
    }
  }, [])

  return isFullScreen
}
