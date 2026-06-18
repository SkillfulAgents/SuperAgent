import { useRouter } from '@tanstack/react-router'
import { Button, buttonVariants } from '@renderer/components/ui/button'
import { AppLink } from '@renderer/components/ui/app-link'

/**
 * Rendered when the agent loader hits 403 OR 404 — deliberately ONE ambiguous
 * screen (anti-enumeration): we never reveal whether the agent exists but is
 * forbidden, or simply doesn't exist. It replaces the agent shell inside the
 * persistent app shell (the sidebar stays).
 */
export function AgentNotFound() {
  return (
    <div
      data-testid="agent-not-found"
      className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center"
    >
      <h2 className="text-lg font-medium">Agent not available</h2>
      <p className="max-w-sm text-sm text-muted-foreground">
        This agent doesn’t exist, or you don’t have access to it.
      </p>
      {/* Style the link directly (buttonVariants) rather than `<Button asChild>` —
          a Radix Slot wrapping <AppLink> trips React.Children.only here. */}
      <AppLink to="/" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
        Back to home
      </AppLink>
    </div>
  )
}

/**
 * Rendered when the agent loader fails with a 5xx / network error (NOT 403/404).
 * `router.invalidate()` re-runs the loader so a transient failure can recover
 * without a full reload.
 */
export function AgentLoadError() {
  const router = useRouter()
  return (
    <div
      data-testid="agent-load-error"
      className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center"
    >
      <h2 className="text-lg font-medium">Couldn’t load this agent</h2>
      <p className="max-w-sm text-sm text-muted-foreground">
        Something went wrong. Please try again.
      </p>
      <Button variant="outline" size="sm" onClick={() => void router.invalidate()}>
        Retry
      </Button>
    </div>
  )
}

/**
 * Rendered by the session leaf when the session 404s with no optimistic message
 * in flight — a deep-link to a non-existent / deleted session. Stays inside the
 * agent shell (sidebar + agent header remain), with a link back to the agent
 * home.
 */
export function SessionNotFound({ agentSlug }: { agentSlug: string }) {
  return (
    <div
      data-testid="session-not-found"
      className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center"
    >
      <h2 className="text-lg font-medium">Session not available</h2>
      <p className="max-w-sm text-sm text-muted-foreground">
        This session doesn’t exist, or it was deleted.
      </p>
      <AppLink
        to="/agents/$slug"
        params={{ slug: agentSlug }}
        className={buttonVariants({ variant: 'outline', size: 'sm' })}
      >
        Back to agent
      </AppLink>
    </div>
  )
}

/**
 * Router-level defaults (wired as `defaultNotFoundComponent` /
 * `defaultErrorComponent` on `createRouter`). Without these, an unmatched
 * non-agent URL (e.g. a mistyped `/garbage`) or an unexpected throw on a route
 * that defines no fallback of its own would hit TanStack's bare, unstyled "Not
 * Found". Routes with their own fallbacks (the agent layout) still win. Kept
 * DEAD-SIMPLE on purpose — a fallback that itself throws is swallowed by the
 * sibling error boundary.
 */
export function RouteNotFound() {
  return (
    <div
      data-testid="route-not-found"
      className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center"
    >
      <h2 className="text-lg font-medium">Page not found</h2>
      <p className="max-w-sm text-sm text-muted-foreground">This page doesn’t exist.</p>
      <AppLink to="/" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
        Back to home
      </AppLink>
    </div>
  )
}

export function RouteError() {
  const router = useRouter()
  return (
    <div
      data-testid="route-error"
      className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center"
    >
      <h2 className="text-lg font-medium">Something went wrong</h2>
      <p className="max-w-sm text-sm text-muted-foreground">An unexpected error occurred.</p>
      <Button variant="outline" size="sm" onClick={() => void router.invalidate()}>
        Retry
      </Button>
    </div>
  )
}
