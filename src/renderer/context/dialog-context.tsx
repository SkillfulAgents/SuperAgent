import { createContext, useContext, useCallback } from 'react'
import { useRouter } from '@tanstack/react-router'
import { settingsSearchSchema } from '@renderer/router/search-schemas'

interface DialogContextType {
  /** Open global settings (optionally to a tab); captures the current location as `?from=`. */
  openSettings: (tab?: string) => void
  /** Close settings → push back to the captured `?from=` origin (or home on a cold deep-link). */
  closeSettings: () => void
  openWizard: () => void
}

const DialogContext = createContext<DialogContextType | null>(null)

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
      const from = router.state.location.pathname + router.state.location.searchStr
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
