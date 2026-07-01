import { useEffect, type ReactNode } from 'react'
import { QueryProvider } from '@renderer/providers/query-provider'
import { UserProvider } from '@renderer/context/user-context'
import { AnalyticsProvider } from '@renderer/context/analytics-context'
import { ConnectivityProvider } from '@renderer/context/connectivity-context'
import { DraftsProvider } from '@renderer/context/drafts-context'
import { DialogContext, type DialogContextType } from '@renderer/context/dialog-context'
import { useTheme } from '@renderer/hooks/use-theme'
import { Toaster } from '@renderer/components/ui/sonner'
import { QuickDispatch } from './quick-dispatch'

/**
 * The launcher window's root. A deliberately slim subset of the main app's
 * provider stack — NO router, NO app shell, NO background SSE — just what the
 * reused composer pieces need:
 *   - QueryProvider     → all the data hooks (agents, settings, create-session)
 *   - UserProvider      → useUser() (no-op/network-free outside auth mode)
 *   - AnalyticsProvider → useAnalyticsTracking() in create-session / voice
 *   - ConnectivityProvider, DraftsProvider → composer state
 *   - DialogContext     → a router-free stub so VoiceInputButton's
 *                         openSettings('voice') routes to the MAIN window
 */

// The real DialogProvider needs the router (it navigates to /settings). Here we
// supply a value that hands the intent to the main process instead.
const launcherDialogValue: DialogContextType = {
  openSettings: () => window.electronAPI?.quickDispatchOpenSettings?.(),
  closeSettings: () => {},
  openWizard: () => {},
}

/** Apply the user's theme (dark/light/system) — same effect the main app uses. */
function ThemeSync({ children }: { children: ReactNode }) {
  useTheme()
  return <>{children}</>
}

/**
 * Keep the frameless panel sized to its contents. Measures the rendered card
 * (plus any open Radix dropdown, which portals to <body> outside #root) and
 * tells the main process to set the window's content height. rAF-throttled.
 */
function AutoResizeWindow() {
  useEffect(() => {
    let raf = 0
    const measure = () => {
      raf = 0
      // Never measure from a scrolled state: a stray focus-into-view can scroll
      // the panel up, which would make getBoundingClientRect under-report the
      // card height and freeze the window too short. Snap back to the top first.
      const se = document.scrollingElement
      if (se && se.scrollTop !== 0) se.scrollTop = 0
      // Measure the launcher card itself — NOT #root, which globals.css stretches
      // to full height (would make the frameless window measure full-screen-tall).
      const card = document.querySelector('[data-testid="quick-dispatch"]')
      let bottom = card ? card.getBoundingClientRect().bottom : 0
      // The inline menus grow the card itself, but a few reused bits still portal
      // a Radix popper to <body> outside the card (e.g. the mic button's tooltip).
      // Include any such popper so the window grows to fit it instead of clipping.
      let popperOpen = false
      document.querySelectorAll('[data-radix-popper-content-wrapper]').forEach((el) => {
        popperOpen = true
        bottom = Math.max(bottom, (el as HTMLElement).getBoundingClientRect().bottom)
      })
      // Resting: hug tight (+2, no "chin"). With a dropdown open: a little more so
      // its shadow isn't clipped at the window edge.
      window.electronAPI?.quickDispatchResize?.(Math.ceil(bottom) + (popperOpen ? 10 : 2))
    }
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(measure)
    }
    const ro = new ResizeObserver(schedule)
    ro.observe(document.body)
    // Dropdowns/dialogs add & remove portaled nodes under <body>.
    const mo = new MutationObserver(schedule)
    mo.observe(document.body, { childList: true, subtree: true })
    schedule()
    return () => {
      ro.disconnect()
      mo.disconnect()
      if (raf) cancelAnimationFrame(raf)
    }
  }, [])
  return null
}

export function QuickDispatchApp() {
  return (
    <QueryProvider>
      <UserProvider>
        <AnalyticsProvider>
          <ConnectivityProvider>
            <DraftsProvider>
              <DialogContext.Provider value={launcherDialogValue}>
                <ThemeSync>
                  <AutoResizeWindow />
                  <QuickDispatch />
                  <Toaster />
                </ThemeSync>
              </DialogContext.Provider>
            </DraftsProvider>
          </ConnectivityProvider>
        </AnalyticsProvider>
      </UserProvider>
    </QueryProvider>
  )
}
