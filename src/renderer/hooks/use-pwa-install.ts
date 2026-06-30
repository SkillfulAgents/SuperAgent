import { useCallback, useEffect, useState } from 'react'
import { isElectron } from '@renderer/lib/env'

/**
 * The non-standard `beforeinstallprompt` event (Chromium only). Captured so the
 * app can offer a one-tap install from its own UI instead of the browser's
 * default mini-infobar.
 */
interface BeforeInstallPromptEvent extends Event {
  readonly prompt: () => Promise<void>
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

/**
 * How the user can install on the current platform, in priority order:
 *  - `prompt`     Chromium fired `beforeinstallprompt` → we can trigger a real
 *                 one-tap install. (Needs the site to be installable, which today
 *                 requires a service worker — so this won't fire until one ships.)
 *  - `ios-safari` iOS Safari has no install API → Share → "Add to Home Screen".
 *  - `ios-other`  iOS but NOT Safari (Chrome/Firefox/in-app): iOS only allows
 *                 A2HS from Safari, so the user must reopen there.
 *  - `menu`       Anything else (e.g. Android without a captured prompt) → the
 *                 browser's own menu has "Add to Home Screen" / "Install app".
 */
export type InstallMethod = 'prompt' | 'ios-safari' | 'ios-other' | 'menu'

function isStandalonePWA(): boolean {
  if (typeof window === 'undefined') return false
  // iOS Safari exposes navigator.standalone; the spec-standard signal is the
  // standalone display-mode media query (Android/Chromium + modern iOS).
  return (
    window.matchMedia?.('(display-mode: standalone)').matches === true ||
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  )
}

function isIos(): boolean {
  if (typeof navigator === 'undefined') return false
  return (
    /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    // iPadOS 13+ masquerades as macOS; a Mac with a touchscreen is an iPad.
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  )
}

function isIosSafari(): boolean {
  // On iOS every browser is WebKit, but only Safari can Add to Home Screen.
  // Chrome/Firefox/Edge on iOS carry CriOS/FxiOS/EdgiOS in the UA.
  return isIos() && !/crios|fxios|edgios|gsa/i.test(navigator.userAgent)
}

/**
 * Surfaces PWA install state + the platform-appropriate install method for an
 * "Install app" banner. No-ops under Electron (the desktop app isn't a PWA). The
 * caller decides where/whether to show UI — this hook only reports capability.
 */
export function usePwaInstall(): {
  isStandalone: boolean
  canPrompt: boolean
  promptInstall: () => Promise<'accepted' | 'dismissed' | null>
  method: InstallMethod
} {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null)
  const [isStandalone, setIsStandalone] = useState<boolean>(() => isStandalonePWA())

  useEffect(() => {
    // The desktop app is not installable as a PWA — never listen.
    if (isElectron()) return

    const onBeforeInstall = (e: Event) => {
      // Stop Chromium's default mini-infobar; we drive install from our own UI.
      e.preventDefault()
      setDeferredPrompt(e as BeforeInstallPromptEvent)
    }
    const onInstalled = () => {
      setDeferredPrompt(null)
      setIsStandalone(true)
    }
    window.addEventListener('beforeinstallprompt', onBeforeInstall)
    window.addEventListener('appinstalled', onInstalled)

    // Hide the banner the moment the app enters standalone (installed) without
    // needing a reload.
    const mql = window.matchMedia?.('(display-mode: standalone)')
    const onDisplayChange = () => setIsStandalone(isStandalonePWA())
    mql?.addEventListener('change', onDisplayChange)

    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall)
      window.removeEventListener('appinstalled', onInstalled)
      mql?.removeEventListener('change', onDisplayChange)
    }
  }, [])

  const promptInstall = useCallback(async () => {
    if (!deferredPrompt) return null
    await deferredPrompt.prompt()
    const { outcome } = await deferredPrompt.userChoice
    // The event is single-use — drop it so the button can't re-fire a spent prompt.
    setDeferredPrompt(null)
    return outcome
  }, [deferredPrompt])

  const method: InstallMethod = deferredPrompt
    ? 'prompt'
    : isIosSafari()
      ? 'ios-safari'
      : isIos()
        ? 'ios-other'
        : 'menu'

  return { isStandalone, canPrompt: deferredPrompt !== null, promptInstall, method }
}
