/**
 * Marker for a re-auth wait that a person deliberately dismissed, as opposed
 * to one that ran out its timer.
 *
 * A parked proxy request could only end one of two ways before this — the
 * credential came back, or the wait timed out — and both re-auth managers
 * reject with a plain Error. The proxy routes turn any rejection into a 408
 * "timed out", which is the wrong story to tell an agent whose user just said
 * "give up on this one": it invites a retry into the same wall.
 *
 * The flag is duck-typed rather than checked with `instanceof` on purpose.
 * The managers live in shared code that the API bundle and the Electron main
 * bundle each load through their own module instance, so a class identity does
 * not survive the crossing; an own-property flag does.
 */
export class ReauthDismissedError extends Error {
  readonly reauthDismissed = true
  /** What the person typed, if anything. Forwarded to the agent verbatim. */
  readonly dismissReason?: string

  constructor(message: string, dismissReason?: string) {
    super(message)
    this.name = 'ReauthDismissedError'
    this.dismissReason = dismissReason
  }
}

export function isReauthDismissed(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { reauthDismissed?: unknown }).reauthDismissed === true
  )
}

/** The dismisser's stated reason, if they gave one. Read alongside {@link isReauthDismissed}. */
export function reauthDismissalReason(error: unknown): string | undefined {
  if (!isReauthDismissed(error)) return undefined
  const reason = (error as { dismissReason?: unknown }).dismissReason
  return typeof reason === 'string' && reason ? reason : undefined
}

/** The message the parked agent request is failed with. */
export function reauthDismissedMessage(subject: string, reason?: string): string {
  const base = `${subject} was dismissed by a user`
  return reason ? `${base}: ${reason}` : base
}

/**
 * Append the dismisser's own words to the agent-facing explanation. Kept here
 * so both proxies phrase it identically — the agent reads this as the reason a
 * tool call it made came back empty.
 */
export function withDismissalReason(message: string, reason?: string): string {
  return reason ? `${message} They said: "${reason}"` : message
}
