/**
 * Trigger Manager
 *
 * Background process that handles incoming webhook events from Composio.
 * On startup: polls for pending events, subscribes to Supabase Realtime.
 * On event: looks up trigger in SQLite, starts agent session with prompt + payload.
 * Batches multiple events for the same trigger into a single session.
 */

import { getPlatformProxyBaseUrl } from '@shared/lib/platform-auth/config'
import { attribution, type Attribution } from '@shared/lib/attribution'
import { containerManager } from '@shared/lib/container/container-manager'
import { getEffectiveModels } from '@shared/lib/config/settings'
import { messagePersister } from '@shared/lib/container/message-persister'
import { notificationManager } from '@shared/lib/notifications/notification-manager'
import {
  getWebhookTriggersByComposioId,
  listWebhookTriggerAuths,
  markTriggerFired,
  markTriggerFailed,
} from '@shared/lib/services/webhook-trigger-service'
import type { WebhookTrigger } from '@shared/lib/services/webhook-trigger-service'
import {
  registerSession,
  updateSessionMetadata,
} from '@shared/lib/services/session-service'
import { getSecretEnvVars } from '@shared/lib/services/secrets-service'
import { agentExists } from '@shared/lib/services/agent-service'
import {
  pollAndClaimEvents,
  acknowledgeEvents,
} from '@shared/lib/services/webhook-events-client'
import type { WebhookEvent } from '@shared/lib/services/webhook-events-client'
import { SupabaseRealtimeClient } from '@shared/lib/services/supabase-realtime-client'

function composeTriggerPrompt(trigger: WebhookTrigger, events: WebhookEvent[]): string {
  const payloads =
    events.length === 1
      ? `Webhook payload:\n\`\`\`json\n${JSON.stringify(events[0].payload, null, 2)}\n\`\`\``
      : events
          .map(
            (e, i) =>
              `Event ${i + 1}:\n\`\`\`json\n${JSON.stringify(e.payload, null, 2)}\n\`\`\``
          )
          .join('\n\n')

  return `${trigger.prompt}\n\n---\n\n${payloads}`
}

class TriggerManager {
  private isRunning = false
  private realtimeClients = new Map<string, SupabaseRealtimeClient>()
  private jwtRefreshIntervals = new Map<string, NodeJS.Timeout>()
  private isProcessing = false

  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('[TriggerManager] Already running')
      return
    }

    this.isRunning = true

    const proxyUrl = getPlatformProxyBaseUrl()
    if (!proxyUrl) {
      console.log('[TriggerManager] Platform proxy URL not configured, skipping')
      this.isRunning = false
      return
    }

    console.log('[TriggerManager] Starting...')

    try {
      await this.pollAndProcess()
    } catch (error) {
      console.error('[TriggerManager] Initial poll failed:', error)
    }
  }

  stop(): void {
    this.isRunning = false

    for (const client of this.realtimeClients.values()) {
      client.disconnect()
    }
    this.realtimeClients.clear()

    for (const interval of this.jwtRefreshIntervals.values()) {
      clearInterval(interval)
    }
    this.jwtRefreshIntervals.clear()

    console.log('[TriggerManager] Stopped')
  }

  isActive(): boolean {
    return this.isRunning
  }

  /**
   * Discover and subscribe to a lane for `ownerUserId` if we don't have one
   * yet. Called by the trigger-creation path so a brand-new owner doesn't
   * have to wait for the next process restart to start receiving events.
   *
   * Idempotent: existing active lane = no-op.
   */
  async ensureLaneForOwner(ownerUserId: string | null): Promise<void> {
    if (!this.isRunning) return
    const auth = attribution.fromResourceCreator(ownerUserId)
    if (!auth) return
    const laneKey = auth.getKey()
    if (this.realtimeClients.get(laneKey)?.isActive()) return
    try {
      await this.pollAndProcessLane(auth)
    } catch (error) {
      console.error(`[TriggerManager] Failed to ensure lane ${laneKey}:`, error)
    }
  }

  private async pollAndProcess(): Promise<void> {
    if (this.isProcessing) return
    this.isProcessing = true

    try {
      const auths = await listWebhookTriggerAuths()
      for (const auth of auths) {
        await this.pollAndProcessLane(auth)
      }
    } catch (error) {
      console.error('[TriggerManager] Poll failed:', error)
    } finally {
      this.isProcessing = false
    }
  }

  private async pollAndProcessLane(auth: Attribution): Promise<void> {
    const laneKey = auth.getKey()
    const result = await pollAndClaimEvents(auth)

    if (result.events.length > 0) {
      console.log(`[TriggerManager] Processing ${result.events.length} event(s) for lane ${laneKey}`)
      await this.processEvents(auth, result.events)
    }

    const realtimeClient = this.realtimeClients.get(laneKey)
    if (result.realtime && !realtimeClient?.isActive()) {
      await this.subscribeToRealtime(auth, result.realtime)
    }
  }

  private async subscribeToRealtime(
    auth: Attribution,
    config: { url: string; apikey: string; jwt: string; channel: string }
  ): Promise<void> {
    const laneKey = auth.getKey()
    const existingClient = this.realtimeClients.get(laneKey)
    if (existingClient) {
      existingClient.disconnect()
    }

    const realtimeClient = new SupabaseRealtimeClient()
    this.realtimeClients.set(laneKey, realtimeClient)

    try {
      await realtimeClient.connect(
        config,
        () => {
          // On any INSERT event, re-poll to claim and process
          this.pollAndProcessLane(auth).catch((err) => {
            console.error(`[TriggerManager] Re-poll after realtime event failed for lane ${laneKey}:`, err)
          })
        },
        () => {
          // On disconnect, the client handles reconnection internally
        },
      )

      // Refresh JWT every 50 minutes (token lasts 1 hour)
      const existingInterval = this.jwtRefreshIntervals.get(laneKey)
      if (existingInterval) {
        clearInterval(existingInterval)
      }

      const refreshInterval = setInterval(async () => {
        try {
          const freshResult = await pollAndClaimEvents(auth)
          const latestClient = this.realtimeClients.get(laneKey)
          if (freshResult.realtime?.jwt && latestClient) {
            await latestClient.updateToken(freshResult.realtime.jwt)
          }
          // Also process any events that came in during the refresh
          if (freshResult.events.length > 0) {
            await this.processEvents(auth, freshResult.events)
          }
        } catch (error) {
          console.error(`[TriggerManager] JWT refresh failed for lane ${laneKey}:`, error)
        }
      }, 50 * 60 * 1000)
      this.jwtRefreshIntervals.set(laneKey, refreshInterval)

      console.log(`[TriggerManager] Realtime subscription active for lane ${laneKey}`)
    } catch (error) {
      console.error(`[TriggerManager] Failed to subscribe to realtime for lane ${laneKey}:`, error)
    }
  }

  private async processEvents(auth: Attribution, events: WebhookEvent[]): Promise<void> {
    // Group events by composio_trigger_id for batching
    const grouped = new Map<string, WebhookEvent[]>()
    for (const event of events) {
      const key = event.composio_trigger_id
      let list = grouped.get(key)
      if (!list) {
        list = []
        grouped.set(key, list)
      }
      list.push(event)
    }

    for (const [composioTriggerId, groupedEvents] of grouped) {
      try {
        await this.processEventGroup(auth, composioTriggerId, groupedEvents)
      } catch (error) {
        console.error(
          `[TriggerManager] Failed to process events for trigger ${composioTriggerId}:`,
          error
        )
        // Ack events anyway to prevent them from piling up
        await acknowledgeEvents(groupedEvents.map((e) => e.id), auth).catch(console.error)
      }
    }
  }

  private async processEventGroup(
    auth: Attribution,
    composioTriggerId: string,
    events: WebhookEvent[]
  ): Promise<void> {
    // Look up ALL local triggers sharing this Composio trigger ID
    const triggers = await getWebhookTriggersByComposioId(composioTriggerId)
    const activeTriggers = triggers.filter((t) => t.status === 'active')

    if (activeTriggers.length === 0) {
      console.warn(
        `[TriggerManager] No active local triggers for composio ID ${composioTriggerId}, acking events`
      )
      await acknowledgeEvents(events.map((e) => e.id), auth)
      return
    }

    // Spawn a session for each local trigger (fan-out)
    for (const trigger of activeTriggers) {
      try {
        await this.spawnSessionForTrigger(trigger, events)
      } catch (error) {
        console.error(
          `[TriggerManager] Failed to spawn session for trigger ${trigger.id}:`,
          error
        )
      }
    }

    // Ack events after all triggers have been processed
    await acknowledgeEvents(events.map((e) => e.id), auth)
  }

  private async spawnSessionForTrigger(
    trigger: WebhookTrigger,
    events: WebhookEvent[]
  ): Promise<void> {
    // Verify agent still exists
    if (!(await agentExists(trigger.agentSlug))) {
      console.error(
        `[TriggerManager] Agent ${trigger.agentSlug} no longer exists, marking trigger as failed`
      )
      await markTriggerFailed(trigger.id, 'Agent no longer exists')
      return
    }

    // Compose prompt with batched payloads
    const prompt = composeTriggerPrompt(trigger, events)

    // Start agent session
    const client = await containerManager.ensureRunning(trigger.agentSlug)
    const availableEnvVars = await getSecretEnvVars(trigger.agentSlug)

    const containerSession = await client.createSession({
      availableEnvVars: availableEnvVars.length > 0 ? availableEnvVars : undefined,
      initialMessage: prompt,
      model: getEffectiveModels().agentModel,
      browserModel: getEffectiveModels().browserModel,
    })

    const sessionId = containerSession.id
    const sessionName = trigger.name || `Webhook: ${trigger.triggerType}`

    await registerSession(trigger.agentSlug, sessionId, sessionName)
    await updateSessionMetadata(trigger.agentSlug, sessionId, {
      isWebhookExecution: true,
      webhookTriggerId: trigger.id,
      webhookTriggerName: trigger.name || undefined,
    })

    await messagePersister.subscribeToSession(
      sessionId,
      client,
      sessionId,
      trigger.agentSlug
    )
    messagePersister.markSessionActive(sessionId, trigger.agentSlug)

    // Update trigger tracking
    await markTriggerFired(trigger.id, sessionId)

    console.log(
      `[TriggerManager] Trigger ${trigger.id} fired, session: ${sessionId} (${events.length} event(s))`
    )

    // Notification
    notificationManager
      .triggerWebhookSessionStarted(sessionId, trigger.agentSlug, trigger.name || undefined)
      .catch((err) => {
        console.error('[TriggerManager] Failed to trigger notification:', err)
      })
  }
}

// Export singleton instance (persists across hot reloads)
const globalForTriggerManager = globalThis as unknown as {
  triggerManager: TriggerManager | undefined
}

export const triggerManager =
  globalForTriggerManager.triggerManager ?? new TriggerManager()

if (process.env.NODE_ENV !== 'production') {
  globalForTriggerManager.triggerManager = triggerManager
}
