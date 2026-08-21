import { useState, useCallback, useEffect, useRef } from 'react'
import { useUser } from '@renderer/context/user-context'
import { stashRedirectTarget } from '@renderer/lib/api'
import { targetIsRemote } from '@renderer/lib/api-target'
import { AuthPage } from './auth-page'
import { ForcePasswordChange } from './force-password-change'
import { WorkspaceReconnect } from './workspace-reconnect'

/**
 * Shown while the session check is in flight — which, for a cloud workspace, is
 * a round trip to a machine somewhere else.
 *
 * Two things keep that from reading as a flash. `data-boot-surface` keeps the
 * window's own material (see the vibrancy rules in `globals.css`) instead of
 * laying an opaque sheet over it: this screen is not a page the user asked for,
 * it is the gap before one. And the text waits half a second before fading in,
 * so a switch that resolves quickly shows no interstitial at all rather than a
 * word that appears and vanishes.
 */
function LoadingScreen() {
  return (
    <div data-boot-surface className="flex items-center justify-center h-screen bg-background">
      <div className="text-muted-foreground text-sm animate-in fade-in duration-300 delay-500 fill-mode-both">
        Loading...
      </div>
    </div>
  )
}

/**
 * Tell main the window has something on it, so a switch overlay can lift.
 *
 * Here rather than in the shell because this gate decides what a boot ends up
 * showing, and every one of its answers counts — the reconnect screen and the
 * login form are as much "painted" as the app is. Waiting for the shell would
 * leave the band up over the two states where the user most needs to see what
 * happened.
 *
 * Fires on every boot, switch or not; main has nothing to lift the rest of the
 * time. Two frames, because React having rendered is not the compositor having
 * drawn, and lifting a frame early shows the blank we are covering.
 *
 * The latch is set when the message is **sent**, not when it is scheduled. Set
 * early, it made the frames the signal waits on into a window where the whole
 * thing could be lost: StrictMode mounts, cleans up and mounts again, cancelling
 * the frames in between — and the second mount then found the latch already
 * closed and scheduled nothing. That only bit a boot whose gate was never
 * pending, which is to say a *local* boot, so switching to this computer sat
 * under the band until main's fallback timed it out while switching to the
 * cloud looked fine.
 */
function useSignalPainted(isPending: boolean): void {
  const signalled = useRef(false)
  useEffect(() => {
    if (signalled.current || isPending) return
    let cancelled = false
    const outer = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (cancelled) return
        signalled.current = true
        window.electronAPI?.signalRendererPainted?.()
      })
    })
    return () => {
      cancelled = true
      cancelAnimationFrame(outer)
    }
  }, [isPending])
}

export function AuthGate({ children }: { children: React.ReactNode }) {
  const { isAuthMode, isAuthenticated, isPending, mustChangePassword } = useUser()
  const [pendingApproval, setPendingApproval] = useState(false)
  useSignalPainted(isPending && !pendingApproval)

  const onPendingApproval = useCallback((pending = true) => setPendingApproval(pending), [])

  // Track whether this tab was EVER authenticated, so we can tell a cold load
  // (never authenticated → AuthPage) from a sign-out (authenticated → AuthPage).
  const wasAuthenticatedRef = useRef(false)
  useEffect(() => {
    if (isAuthenticated) wasAuthenticatedRef.current = true
  }, [isAuthenticated])

  // A signed-out cold deep-link renders AuthPage WITHOUT the router ever mounting,
  // so no API call fires and the 401 handler never stashes the target. Stash it
  // here once the session check settles unauthenticated, so OAuth (via
  // peekRedirectStash → callbackURL) and email login both return to the deep link
  // instead of home. Guard on `!wasAuthenticatedRef`: stashing on a SIGN-OUT
  // would persist the signed-out user's private path and leak it into the next
  // user's session on a shared tab (the sign-out path also clears the stash).
  useEffect(() => {
    if (isAuthMode && !isPending && !isAuthenticated && !wasAuthenticatedRef.current) {
      stashRedirectTarget(window.location.pathname + window.location.search + window.location.hash)
    }
  }, [isAuthMode, isPending, isAuthenticated])

  if (!isAuthMode) return <>{children}</>
  if (isPending && !pendingApproval) return <LoadingScreen />
  // A cloud workspace authenticates with a token held by the main process, so
  // there is no password to ask for — offer reconnection instead of a login form.
  if (!isAuthenticated && targetIsRemote()) return <WorkspaceReconnect />
  if (!isAuthenticated || pendingApproval) return <AuthPage onPendingApproval={onPendingApproval} />
  if (mustChangePassword) return <ForcePasswordChange />
  return <>{children}</>
}
