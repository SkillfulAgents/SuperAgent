import { useState, useEffect, useCallback } from 'react'
import { isElectron } from '@renderer/lib/env'

/**
 * Hook to track whether the Electron window is in full screen mode.
 * Returns false for web (non-Electron) environment.
 */
export function useFullScreen(): boolean {
  const [isFullScreen, setIsFullScreen] = useState(false)

  const checkFullScreen = useCallback(() => {
    window.electronAPI?.getFullScreenState().then(setIsFullScreen)
  }, [])

  useEffect(() => {
    if (!isElectron() || !window.electronAPI) {
      return
    }

    // Get initial state
    checkFullScreen()

    // Listen for changes via IPC
    window.electronAPI.onFullScreenChange(setIsFullScreen)

    // Also re-check on resize as a fallback — fullscreen transitions trigger resize
    window.addEventListener('resize', checkFullScreen)

    return () => {
      window.electronAPI?.removeFullScreenChange()
      window.removeEventListener('resize', checkFullScreen)
    }
  }, [checkFullScreen])

  return isFullScreen
}
