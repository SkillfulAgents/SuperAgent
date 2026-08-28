import { useCallback, useEffect, useState } from 'react'

/**
 * Dev-build-only UI flag for previewing hard-to-reach states (e.g. rendering
 * the Home tab as if no agents exist, so the empty state can be designed
 * against a populated dev database). Persisted per flag in localStorage so the
 * preview survives reloads while iterating. Inert in production builds: the
 * value is always false and toggle is a no-op — and any control that flips a
 * flag should itself be gated on import.meta.env.DEV so it never ships.
 */
export function useDevFlag(name: string): [boolean, () => void] {
  const key = `superagent-dev-flag.${name}`
  const [enabled, setEnabled] = useState(
    () => import.meta.env.DEV && localStorage.getItem(key) === '1',
  )
  useEffect(() => {
    if (!import.meta.env.DEV) return
    localStorage.setItem(key, enabled ? '1' : '0')
  }, [key, enabled])
  const toggle = useCallback(() => {
    if (!import.meta.env.DEV) return
    setEnabled((v) => !v)
  }, [])
  return [enabled, toggle]
}
