import type { LiveConversationSetting } from '../voice/live-types'
import { agentIntegrationRegistry } from './registry'
import { getIntegration, getIntegrationSessionBySessionId } from './store'

/**
 * Where a voice conversation is taking place. A session an integration owns
 * (a meeting) is described by that integration's provider; any other session
 * is a person alone with the app and gets no setting. The voice host calls
 * this with the agent and session it has already authorized; nothing here
 * trusts the browser.
 */
export async function resolveLiveConversationSetting(agentSlug: string, sessionId: string): Promise<LiveConversationSetting | undefined> {
  const session = await getIntegrationSessionBySessionId(agentSlug, sessionId)
  if (!session) return undefined
  const record = await getIntegration(session.integrationId)
  if (!record || record.agentSlug !== agentSlug) return undefined
  return agentIntegrationRegistry.liveSetting(record, session.externalId)
}
