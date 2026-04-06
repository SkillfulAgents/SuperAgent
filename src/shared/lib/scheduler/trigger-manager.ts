/**
 * Trigger Manager
 *
 * Background process that handles incoming webhook events from Composio.
 * On startup: polls for pending events, subscribes to Supabase Realtime.
 * On event: looks up trigger in SQLite, starts agent session with prompt + payload.
 * Batches multiple events for the same trigger into a single session.
 */

import { containerManager } from '@shared/lib/container/container-manager'
import { getEffectiveModels } from '@shared/lib/config/settings'
import { messagePersister } from '@shared/lib/container/message-persister'
import { notificationManager } from '@shared/lib/notifications/notification-manager'
import {
  getWebhookTriggersByComposioId,
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
  private realtimeClient: SupabaseRealtimeClient | null = null
  private jwtRefreshInterval: NodeJS.Timeout | null = null
  private isProcessing = false

  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('[TriggerManager] Already running')
      return
    }

    this.isRunning = true
    console.log('[TriggerManager] Starting...')

    try {
      await this.pollAndProcess()
    } catch (error) {
      console.error('[TriggerManager] Initial poll failed:', error)
    }
  }

  stop(): void {
    this.isRunning = false

    if (this.realtimeClient) {
      this.realtimeClient.disconnect()
      this.realtimeClient = null
    }

    if (this.jwtRefreshInterval) {
      clearInterval(this.jwtRefreshInterval)
      this.jwtRefreshInterval = null
    }

    console.log('[TriggerManager] Stopped')
  }

  isActive(): boolean {
    return this.isRunning
  }

  private async pollAndProcess(): Promise<void> {
    if (this.isProcessing) return
    this.isProcessing = true

    try {
      const result = await pollAndClaimEvents()

      // Process claimed events
      if (result.events.length > 0) {
        console.log(`[TriggerManager] Processing ${result.events.length} event(s)`)
        await this.processEvents(result.events)
      }

      // Set up Realtime subscription if we got connection info
      if (result.realtime && !this.realtimeClient?.isActive()) {
        await this.subscribeToRealtime(result.realtime)
      }
    } catch (error) {
      console.error('[TriggerManager] Poll failed:', error)
    } finally {
      this.isProcessing = false
    }
  }

  private async subscribeToRealtime(
    config: { url: string; jwt: string; channel: string }
  ): Promise<void> {
    if (this.realtimeClient) {
      this.realtimeClient.disconnect()
    }

    this.realtimeClient = new SupabaseRealtimeClient()

    try {
      await this.realtimeClient.connect(
        config,
        () => {
          // On any INSERT event, re-poll to claim and process
          this.pollAndProcess().catch((err) => {
            console.error('[TriggerManager] Re-poll after realtime event failed:', err)
          })
        },
        () => {
          // On disconnect, the client handles reconnection internally
        },
      )

      // Refresh JWT every 50 minutes (token lasts 1 hour)
      this.jwtRefreshInterval = setInterval(async () => {
        try {
          const freshResult = await pollAndClaimEvents()
          if (freshResult.realtime?.jwt && this.realtimeClient) {
            await this.realtimeClient.updateToken(freshResult.realtime.jwt)
          }
          // Also process any events that came in during the refresh
          if (freshResult.events.length > 0) {
            await this.processEvents(freshResult.events)
          }
        } catch (error) {
          console.error('[TriggerManager] JWT refresh failed:', error)
        }
      }, 50 * 60 * 1000)

      console.log('[TriggerManager] Realtime subscription active')
    } catch (error) {
      console.error('[TriggerManager] Failed to subscribe to realtime:', error)
    }
  }

  private async processEvents(events: WebhookEvent[]): Promise<void> {
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
        await this.processEventGroup(composioTriggerId, groupedEvents)
      } catch (error) {
        console.error(
          `[TriggerManager] Failed to process events for trigger ${composioTriggerId}:`,
          error
        )
        // Ack events anyway to prevent them from piling up
        await acknowledgeEvents(groupedEvents.map((e) => e.id)).catch(console.error)
      }
    }
  }

  private async processEventGroup(
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
      await acknowledgeEvents(events.map((e) => e.id))
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
    await acknowledgeEvents(events.map((e) => e.id))
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
