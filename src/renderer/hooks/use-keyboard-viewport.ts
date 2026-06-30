import { useEffect } from 'react'
import { isElectron } from '@renderer/lib/env'

/**
 * Toggles `data-keyboard-open` on <html> while the soft keyboard is up (mobile
 * web/PWA), detected via the VisualViewport. globals.css uses it to drop the
 * composer's home-indicator safe-area padding while the keyboard covers the
 * bottom, so the composer sits flush above the keyboard instead of floating a
 * safe-area gap above it.
 *
 * (We do NOT try to keep the top nav pinned / shrink the shell while the keyboard
 * is up — every approach either fights iOS's native focus-pan animation (janky)
 * or collapses the layout, and iOS Safari has no declarative keyboard support
 * (`interactive-widget` / VirtualKeyboard API are Chromium-only as of 2026). So
 * the content rides iOS's smooth native pan; we only fix the safe-area gap.)
 *
 * Detection note: `window.innerHeight` is unreliable on iOS (it collapses to the
 * visual viewport when the keyboard opens), so we compare the visual viewport
 * against the layout viewport (`documentElement.clientHeight`), which stays at
 * 100dvh. No-op on desktop/Electron (no soft keyboard). Mounted once at the app
 * root.
 */
export function useKeyboardViewport() {
  useEffect(() => {
    // Electron uses native OS windows with no soft keyboard — never engage.
    if (isElectron()) return
    const vv = window.visualViewport
    if (!vv) return

    const root = document.documentElement
    let raf = 0

    const apply = () => {
      raf = 0
      // A gap > ~100px between the layout viewport and the visual viewport means
      // the keyboard is up (ignore small address-bar show/hide fluctuations).
      const open = root.clientHeight - vv.height > 100
      if (open) root.setAttribute('data-keyboard-open', '')
      else root.removeAttribute('data-keyboard-open')
    }

    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(apply)
    }

    apply()
    vv.addEventListener('resize', schedule)
    vv.addEventListener('scroll', schedule)
    return () => {
      vv.removeEventListener('resize', schedule)
      vv.removeEventListener('scroll', schedule)
      if (raf) cancelAnimationFrame(raf)
      root.removeAttribute('data-keyboard-open')
    }
  }, [])
}
