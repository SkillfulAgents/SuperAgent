import { useEffect, useState } from 'react'
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

/**
 * Reads back the `dark` class that useTheme() applies to <html>.
 *
 * For components that must resolve the theme in JS rather than in CSS —
 * canvas painters, Monaco, anything handed an explicit color. Prefer a
 * Tailwind `dark:` variant whenever the value can live in a stylesheet.
 */
export function useIsDark(): boolean {
  const [isDark, setIsDark] = useState(
    () => typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
  )

  useEffect(() => {
    const el = document.documentElement
    const observer = new MutationObserver(() => setIsDark(el.classList.contains('dark')))
    observer.observe(el, { attributes: true, attributeFilter: ['class'] })
    // useTheme() may have toggled the class between our initial read and here.
    setIsDark(el.classList.contains('dark'))
    return () => observer.disconnect()
  }, [])

  return isDark
}
