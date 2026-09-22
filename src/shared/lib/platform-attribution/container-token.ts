import { attribution } from './index'
import { getPlatformAccessToken } from '../services/platform-auth-service'
import { captureMessage } from '../error-reporting'

/** Shared by Platform inference and services, including background container starts. */
export async function getPlatformContainerToken(agentId?: string): Promise<string | undefined> {
  const token = getPlatformAccessToken()
  if (!token) return undefined

  // A container is shared by sessions. Without an ambient request (scheduler,
  // recovery), resolve the agent owner before falling back to the org token.
  const auth = await (agentId ? attribution.forAgent(agentId) : attribution.current())
  if (!auth && attribution.requiresActingMember()) {
    console.warn(`[Platform] No acting member resolved for agent ${agentId ?? '(none)'}; baking bare org token`)
    captureMessage('platform container env built without acting member', {
      level: 'warning',
      tags: { area: 'platform-attribution', op: 'container.env.no_member' },
      extra: { agentId: agentId ?? null },
    })
  }
  return auth?.bearerToken() ?? token
}
