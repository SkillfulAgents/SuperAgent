import { useEffect } from 'react'
import { useSettings } from './use-settings'

export function useTheme() {
  const { data: settings } = useSettings()
  const themeSetting = settings?.app?.theme ?? 'system'

  // Apply dark class to document based on theme setting + system preference
  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')

    function applyTheme() {
      const isDark =
        themeSetting === 'dark' || (themeSetting === 'system' && mediaQuery.matches)
      document.documentElement.classList.toggle('dark', isDark)
    }

    applyTheme()
    mediaQuery.addEventListener('change', applyTheme)
    return () => mediaQuery.removeEventListener('change', applyTheme)
  }, [themeSetting])

  // Sync Electron native theme for vibrancy
  useEffect(() => {
    window.electronAPI?.setNativeTheme(themeSetting)
  }, [themeSetting])
}
