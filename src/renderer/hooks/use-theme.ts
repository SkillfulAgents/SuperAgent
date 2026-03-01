import { useEffect } from 'react'
import { useUserSettings } from './use-user-settings'

export function useTheme() {
  const { data: userSettings } = useUserSettings()
  const themeSetting = userSettings?.theme ?? 'system'

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
