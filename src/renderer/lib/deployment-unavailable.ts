import { z } from 'zod'

// The cloud router answers API calls with this 503 body while the workspace is not ready.
const deploymentUnavailableBodySchema = z.object({
  error: z.literal('deployment_unavailable'),
  state: z.string().optional(),
})

const STATE_MESSAGES: Record<string, string> = {
  sleeping: 'Workspace is asleep. Wake it to continue.',
  waking: 'Workspace is waking up. Try again in a moment.',
  provisioning: 'Workspace is still being set up. Try again in a moment.',
  stopping: 'Workspace is stopping. Try again in a moment.',
  error: 'Workspace is unavailable. Check its status in Platform.',
}

// Expected, transient condition — not an app failure. Query error reporting skips it.
export class DeploymentUnavailableError extends Error {
  readonly state: string

  constructor(state: string) {
    super(STATE_MESSAGES[state] ?? `Workspace is not ready (${state}). Try again shortly.`)
    this.name = 'DeploymentUnavailableError'
    this.state = state
  }
}

export function deploymentUnavailableFromResponse(
  status: number,
  body: unknown,
): DeploymentUnavailableError | null {
  if (status !== 503) return null
  const parsed = deploymentUnavailableBodySchema.safeParse(body)
  if (!parsed.success) return null
  return new DeploymentUnavailableError(parsed.data.state ?? 'unknown')
}
