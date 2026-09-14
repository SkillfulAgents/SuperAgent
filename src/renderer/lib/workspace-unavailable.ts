// Set by the cloud router when it answers for a workspace that is not ready.
// The value is the route state (sleeping, waking, ...) or "unreachable".
export const WORKSPACE_UNAVAILABLE_HEADER = 'x-workspace-unavailable'

const STATE_DESCRIPTIONS: Record<string, string> = {
  sleeping: 'asleep',
  waking: 'starting up',
  provisioning: 'being set up',
  stopping: 'shutting down',
  unreachable: 'unreachable',
}

// The router's not-ready reply, not an API response. Expected while a
// workspace sleeps or wakes, so it is never reported as an error.
export class WorkspaceUnavailableError extends Error {
  constructor(public readonly state: string) {
    const described = STATE_DESCRIPTIONS[state] ?? 'not available right now'
    super(`Your cloud workspace is ${described}. Please try again in a moment.`)
    this.name = 'WorkspaceUnavailableError'
  }
}

export function isWorkspaceUnavailableError(error: unknown): error is WorkspaceUnavailableError {
  return error instanceof WorkspaceUnavailableError
}
