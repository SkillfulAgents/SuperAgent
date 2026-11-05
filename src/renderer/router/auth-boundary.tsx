import { RouterProvider, useRouteContext, type AnyRouter } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useUser } from '@renderer/context/user-context'
import { RoutePending } from './route-fallbacks'

/** Retained matches must not mount the old user's layout or its effects. */
export function AuthRouteBoundary({ children }: { children: ReactNode }) {
  const user = useUser()
  const matchUser = useRouteContext({ from: '__root__' }).user
  if (user.isAuthMode && (user.isPending || matchUser?.authGeneration !== user.authGeneration)) {
    return <RoutePending />
  }
  return <>{children}</>
}

/** Keeps Router's transition machinery mounted while the root guards stale matches. */
export function RouterMount({ router }: { router: AnyRouter }) {
  const queryClient = useQueryClient()
  const user = useUser()
  const requested = useRef<{ generation: object; href: string; key?: string }>()
  const [failure, setFailure] = useState<{ generation: object; error: unknown }>()

  useLayoutEffect(() => {
    const resolved = router.state.resolvedLocation
    const current = router.latestLocation
    if (!resolved) return // Transitioner owns the cold load.
    const matchedGeneration = router.state.matches[0]?.context.user?.authGeneration
    const identityChanged = user.isAuthMode && matchedGeneration !== user.authGeneration
    // A retained Router can miss history changes while AuthGate is unmounted.
    // Its public location records an initiated load; latestLocation is the URL.
    // If Transitioner already started this entry, do not start it a second time.
    const entryChanged = router.state.location.href !== current.href ||
      router.state.location.state.__TSR_key !== current.state.__TSR_key
    if (!identityChanged && !entryChanged) return
    if (requested.current?.generation === user.authGeneration &&
      requested.current.href === current.href && requested.current.key === current.state.__TSR_key) return
    requested.current = { generation: user.authGeneration, href: current.href, key: current.state.__TSR_key }
    // Invalidate all retained loader data on an identity change, even when the
    // URL changed too. Invalidation itself starts exactly one load of that URL.
    const load = identityChanged
      ? router.invalidate({ sync: true, forcePending: true })
      : router.load({ sync: true })
    load.catch(error => {
      // Surface an unexpected Router failure through the app ErrorBoundary,
      // rather than an unhandled rejection or a permanently guarded screen.
      setFailure({ generation: user.authGeneration, error })
    })
  }, [router, user.isAuthMode, user.authGeneration])

  if (failure?.generation === user.authGeneration) throw failure.error
  return <RouterProvider router={router} context={{ queryClient, user }} />
}
