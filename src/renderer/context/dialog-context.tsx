import { createContext, useContext, useCallback } from 'react'
import { useRouter } from '@tanstack/react-router'
import { settingsSearchSchema } from '@renderer/router/search-schemas'

export interface DialogContextType {
  /** Open global settings (optionally to a tab); captures the current location as `?from=`. */
  openSettings: (tab?: string) => void
  /** Close settings → push back to the captured `?from=` origin (or home on a cold deep-link). */
  closeSettings: () => void
  openWizard: () => void
}

// Exported so router-free surfaces (e.g. the standalone quick-dispatch window)
// can supply their own value — VoiceInputButton reads useDialogs().openSettings,
// but the real DialogProvider needs the router, which those surfaces don't mount.
export const DialogContext = createContext<DialogContextType | null>(null)

/**
 * Global settings lives at a URL (`/settings`, `/settings/$tab`); DialogContext is
 * just the intent layer that translates open/close into navigation. Mounted inside
 * RootLayout, so it can use the router. Close uses a `?from=` forward push (not
 * history.back/replace) so history stays honest and the close-target survives a
 * refresh inside settings.
 */
export function DialogProvider({
  children,
  onOpenWizard,
}: {
  children: React.ReactNode
  onOpenWizard: () => void
}) {
  const router = useRouter()

  const openSettings = useCallback(
    (tab?: string) => {
      // Capture where settings was opened FROM as the close-target. If settings
      // is already open (e.g. the open-settings menu command fires twice), the
      // current location IS a /settings URL — re-capturing it would nest the
      // close-target back into settings, so Close would bounce here instead of
      // the real origin. Preserve the existing `from` in that case.
      const onSettings = router.state.location.pathname.startsWith('/settings')
      const from = onSettings
        ? settingsSearchSchema.safeParse(router.state.location.search).data?.from ?? '/'
        : router.state.location.pathname + router.state.location.searchStr
      void router.navigate(
        tab
          ? { to: '/settings/$tab', params: { tab }, search: { from } }
          : { to: '/settings', search: { from } },
      )
    },
    [router],
  )

  const closeSettings = useCallback(() => {
    // `from` was open-redirect-validated by the route's validateSearch; re-read it
    // defensively and push the raw path+search (it may carry a query, e.g. a
    // connections detail) so we land exactly where settings was opened.
    const from = settingsSearchSchema.safeParse(router.state.location.search).data?.from
    router.history.push(from ?? '/')
  }, [router])

  const openWizard = useCallback(() => {
    // The wizard overlays RootLayout's Outlet, so it covers settings without a
    // navigation; closing the wizard returns to whatever route is underneath.
    onOpenWizard()
  }, [onOpenWizard])

  // Menu command "open-settings" is handled centrally by MenuCommandHandler
  // (which calls openSettings) — keeping the menu→action mapping in one place
  // and, post-SUP-264, draining commands queued while the window was closed.

  return (
    <DialogContext.Provider value={{ openSettings, closeSettings, openWizard }}>
      {children}
    </DialogContext.Provider>
  )
}

export function useDialogs(): DialogContextType {
  const ctx = useContext(DialogContext)
  if (!ctx) throw new Error('useDialogs must be used within DialogProvider')
  return ctx
}
