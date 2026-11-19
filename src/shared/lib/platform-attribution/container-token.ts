import { attribution } from './index'
import { getPlatformAccessToken, platformAccessTokenFrom } from '../services/platform-auth-service'
import { captureMessage } from '../error-reporting'
import type { AppSettings } from '../config/settings'

/**
 * Shared by Platform inference and services, including background container
 * starts. `settings`: the global settings the operation already read, for the
 * token; read here when absent.
 */
export async function getPlatformContainerToken(
  agentId?: string,
  settings?: Pick<AppSettings, 'platformAuth'>,
): Promise<string | undefined> {
  const token = settings ? platformAccessTokenFrom(settings) : await getPlatformAccessToken()
  if (!token) return undefined

  // A container is shared by sessions. Without an ambient request (scheduler,
  // recovery), resolve the agent owner before falling back to the org token.
  const auth = await (agentId ? attribution.forAgent(agentId, settings) : attribution.current())
  if (!auth && await attribution.requiresActingMember(settings)) {
    console.warn(`[Platform] No acting member resolved for agent ${agentId ?? '(none)'}; baking bare org token`)
    captureMessage('platform container env built without acting member', {
      level: 'warning',
      tags: { area: 'platform-attribution', op: 'container.env.no_member' },
      extra: { agentId: agentId ?? null },
    })
  }
  return auth?.bearerToken() ?? token
}
