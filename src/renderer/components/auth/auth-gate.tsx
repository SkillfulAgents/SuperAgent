import { useState, useCallback, useEffect, useRef } from 'react'
import { useUser } from '@renderer/context/user-context'
import { stashRedirectTarget } from '@renderer/lib/api'
import { AuthPage } from './auth-page'
import { ForcePasswordChange } from './force-password-change'

function LoadingScreen() {
  return (
    <div className="flex items-center justify-center h-screen bg-background">
      <div className="text-muted-foreground text-sm">Loading...</div>
    </div>
  )
}

export function AuthGate({ children }: { children: React.ReactNode }) {
  const { isAuthMode, isAuthenticated, isPending, mustChangePassword } = useUser()
  const [pendingApproval, setPendingApproval] = useState(false)

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
  if (!isAuthenticated || pendingApproval) return <AuthPage onPendingApproval={onPendingApproval} />
  if (mustChangePassword) return <ForcePasswordChange />
  return <>{children}</>
}
