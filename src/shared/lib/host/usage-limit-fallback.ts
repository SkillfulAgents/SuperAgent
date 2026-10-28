import { randomUUID } from 'crypto'
import { agentRegistry } from '@shared/lib/agent-actor'
import type { HostEvents } from '@shared/lib/agent-actor/host-port'
import { platformFallbackSelection } from '@shared/lib/llm-provider/connections'
import { notificationManager } from '@shared/lib/notifications/notification-manager'
import { SYSTEM_MESSAGE_PREFIX } from '@shared/lib/utils/system-message'

export const USAGE_LIMIT_CONTINUE_MESSAGE =
  `${SYSTEM_MESSAGE_PREFIX}The previous model connection hit its usage limit, so the turn stopped. Continue the user’s task where it stopped. Before retrying an interrupted write, check whether it already completed.`

/**
 * A subscription session that hit its plan's usage limit continues on
 * Platform when its connection opted in: the running turn stops, and a
 * hidden message starts the next one on Platform's model.
 */
export async function continueOnPlatform({ agentSlug, sessionId, turnRunning }: HostEvents['usageLimit']): Promise<void> {
  const actor = agentRegistry.get(agentSlug)
  const metadata = await actor.sessions.metadata(sessionId)
  if (!metadata?.llmProviderId) return
  const fallback = await platformFallbackSelection(metadata.llmProviderId, metadata.model)
  if (!fallback) return
  if (turnRunning) {
    const stopped = await actor.messages.stop(sessionId, { scope: 'turn', ifActive: true, onlyIfConfirmed: true })
    // The turn ended on its own meanwhile, or the user stopped it.
    if (!stopped.interrupted) return
  }
  await actor.messages.deliver({
    sessionId,
    content: USAGE_LIMIT_CONTINUE_MESSAGE,
    uuid: randomUUID(),
    options: { shouldQuery: true, llmProviderId: fallback.to.llmProviderId, model: fallback.to.model },
  })
  await notificationManager.triggerProviderFallback(sessionId, agentSlug, fallback.from.name, fallback.to.model)
}
