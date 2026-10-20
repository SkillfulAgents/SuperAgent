import { attribution } from './index'
import { getPlatformAccessToken } from '../services/platform-auth-service'
import { captureMessage } from '../error-reporting'
import { getOrCreateProxyToken } from '../proxy/token-store'

/** What a container holds for Platform: the app's relay and its own proxy token, never the platform token. */
export async function getPlatformContainerAccess(agentId: string, hostApiBaseUrl: string) {
  return { baseUrl: `${hostApiBaseUrl}/api/platform-proxy`, token: await getOrCreateProxyToken(agentId) }
}

const reportedNoMember = new Set<string>()

/** The platform token for an agent's calls. Only the app's platform relay sends it. */
export async function getPlatformContainerToken(agentId?: string): Promise<string | undefined> {
  const token = getPlatformAccessToken()
  if (!token) return undefined

  // A container is shared by sessions. Without an ambient request (scheduler,
  // recovery), resolve the agent owner before falling back to the org token.
  const auth = await (agentId ? attribution.forAgent(agentId) : attribution.current())
  if (!auth && attribution.requiresActingMember() && !reportedNoMember.has(agentId ?? '')) {
    reportedNoMember.add(agentId ?? '')
    console.warn(`[Platform] No acting member resolved for agent ${agentId ?? '(none)'}; relaying with the bare org token`)
    captureMessage('platform relay call without acting member', {
      level: 'warning',
      tags: { area: 'platform-attribution', op: 'relay.no_member' },
      extra: { agentId: agentId ?? null },
    })
  }
  return auth?.bearerToken() ?? token
}
