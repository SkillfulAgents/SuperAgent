import { useRouter } from '@tanstack/react-router'
import { Button, buttonVariants } from '@renderer/components/ui/button'
import { AppLink } from '@renderer/components/ui/app-link'

/**
 * Rendered when the agent loader hits 403 OR 404 — deliberately ONE ambiguous
 * screen (anti-enumeration, migration plan §9.2): we never reveal whether the
 * agent exists but is forbidden, or simply doesn't exist. It replaces the agent
 * shell inside the persistent app shell (the sidebar stays).
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
 * without a full reload (§9.2).
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
