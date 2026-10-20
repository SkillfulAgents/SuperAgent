/**
 * The webhook trigger host tools: discover and subscribe to Composio
 * triggers, and list, update and cancel the agent's triggers of either kind
 * (Composio triggers and custom webhook endpoints).
 */
import { eq } from 'drizzle-orm'
import type { HostToolRequest, HostToolResult } from '@shared/lib/agent-actor/host-port'
import { globalFeed } from '@shared/lib/notifications/global-feed'
import { db } from '@shared/lib/db'
import { connectedAccounts } from '@shared/lib/db/schema'
import { isPlatformComposioActive } from '@shared/lib/composio/client'
import { deleteComposioTrigger, enableComposioTrigger, getAvailableTriggers } from '@shared/lib/composio/triggers'
import { webhooksUnavailableMessage } from '@shared/lib/webhook-relay'
import { attribution, runWithAttribution } from '@shared/lib/platform-attribution'
import {
  cancelWebhookTriggerWithCleanup,
  createWebhookTrigger,
  getWebhookTrigger,
  listActiveWebhookTriggers,
  updateWebhookTriggerPrompt,
} from '@shared/lib/services/webhook-trigger-service'
import { updateWebhookTriggerInputSchema, type WebhookTriggerUpdateInput } from '@shared/lib/services/automation-update-schema'
import { extractEndpointUrl } from '@shared/lib/services/webhook-endpoint-schema'
import { errorMessage, parseToolInput, rejected, resolved, sessionOwnerOf } from './host-tool-result'
import { resolvePlatformMemberForSession } from './platform-member'

/** Composio triggers need platform Composio, and their events arrive through the webhook relay. */
function composioTriggersUnavailable(): string | null {
  if (!isPlatformComposioActive()) return 'Webhook triggers are only available with platform Composio'
  return webhooksUnavailableMessage('Webhook triggers')
}

async function findConnectedAccount(accountId: string) {
  const [account] = await db.select().from(connectedAccounts).where(eq(connectedAccounts.id, accountId)).limit(1)
  return account
}

export async function getAvailableTriggersTool({ input: raw }: HostToolRequest): Promise<HostToolResult> {
  try {
    const unavailable = composioTriggersUnavailable()
    if (unavailable) return rejected(unavailable)

    const input = parseToolInput<{ connected_account_id: string }>(raw)
    if (input === undefined) return rejected('Invalid tool input')

    const account = await findConnectedAccount(input.connected_account_id)
    if (!account) return rejected(`Connected account ${input.connected_account_id} not found`)

    const triggers = await getAvailableTriggers(account.toolkitSlug)
    if (triggers.length === 0) {
      return resolved(
        'No webhook triggers available for this account.\n\n' +
          'You can still react to events from this service with a custom webhook endpoint:\n' +
          '1. Call create_webhook_endpoint to mint a public URL (with a prompt describing what to do per event).\n' +
          `2. Register that URL with the service — most expose webhook registration via their API (use the connected ${account.toolkitSlug} account) or a settings page.\n` +
          '3. If the service provides a signing secret, attach it with update_webhook_endpoint so deliveries are verified.\n' +
          "4. If the service's webhook events are broader than what you need (most are), add a CEL filter_exp so only matching events start a session — dry-run candidates against real deliveries with inspect_webhook_events first.",
      )
    }
    return resolved(
      `Available triggers for ${account.toolkitSlug}:\n\n${triggers
        .map((t) => `- **${t.slug}** (${t.name}): ${t.description}${t.type === 'poll' ? ' [poll-based]' : ''}`)
        .join('\n')}\n\nUse setup_trigger with the trigger slug to subscribe. ` +
        'For events this catalog does not cover, you can also mint a custom webhook endpoint (create_webhook_endpoint) and register its URL with the service directly — both kinds can run side by side.',
    )
  } catch (error) {
    console.error('[HostTools] Error handling get_available_triggers:', error)
    return rejected(String(error))
  }
}

interface SetupTriggerInput {
  connected_account_id: string
  trigger_type: string
  prompt: string
  name?: string
  trigger_config?: Record<string, unknown>
  model?: string
  effort?: string
  speed?: string
}

/** Subscribe on Composio, then save the trigger locally; a failed save unsubscribes again. */
export async function setupTrigger({ agentSlug, sessionId, toolUseId, input: raw }: HostToolRequest): Promise<HostToolResult> {
  try {
    const unavailable = composioTriggersUnavailable()
    if (unavailable) return rejected(unavailable)

    const input = parseToolInput<SetupTriggerInput>(raw)
    if (input === undefined) return rejected('Invalid tool input')
    if (!input.connected_account_id || !input.trigger_type || !input.prompt) {
      return rejected('Missing required fields: connected_account_id, trigger_type, and prompt are required')
    }

    // The agent names the local account; Composio knows it by its own id.
    const account = await findConnectedAccount(input.connected_account_id)
    if (!account) return rejected(`Connected account ${input.connected_account_id} not found`)

    const validSlugs = (await getAvailableTriggers(account.toolkitSlug)).map((t) => t.slug)
    if (!validSlugs.includes(input.trigger_type)) {
      const suggestion = validSlugs.length > 0
        ? `\n\nAvailable triggers for ${account.toolkitSlug}: ${validSlugs.join(', ')}`
        : `\n\nNo triggers are available for ${account.toolkitSlug}.`
      return rejected(`Invalid trigger type "${input.trigger_type}" for this account.${suggestion}`)
    }

    // The proxy scopes the subscription to the acting member of THIS mint
    // request (ambient ALS), which is not always the session creator
    // (SUP-765). Host tools run off the stream loop with no guaranteed ALS
    // scope, so when none is active mint explicitly under the session's
    // member instead of letting the call go out as a bare org token.
    const sessionMemberId = await resolvePlatformMemberForSession(agentSlug, sessionId)
    const mintAttribution =
      (await attribution.current()) ??
      // Never mint as the opaque-key 'local' placeholder — that would send `token::local`.
      (sessionMemberId === 'local' ? null : attribution.fromMemberId(sessionMemberId))
    const mintedByMemberId = mintAttribution?.actingMemberId() ?? undefined

    // Under mintAttribution, so the recorded member is the one the proxy
    // actually scoped the subscription to, not a guess made afterwards.
    const composioTriggerId = await runWithAttribution(mintAttribution, () =>
      enableComposioTrigger(input.trigger_type, account.providerConnectionId, input.trigger_config),
    )

    let triggerId: string
    try {
      triggerId = await createWebhookTrigger({
        agentSlug,
        composioTriggerId,
        connectedAccountId: input.connected_account_id,
        triggerType: input.trigger_type,
        triggerConfig: input.trigger_config ? JSON.stringify(input.trigger_config) : undefined,
        prompt: input.prompt,
        name: input.name,
        createdBySessionId: sessionId,
        createdByUserId: await sessionOwnerOf(agentSlug, sessionId),
        mintedByMemberId,
        model: input.model,
        effort: input.effort,
        speed: input.speed,
      })
    } catch (dbError) {
      console.error('[HostTools] SQLite save failed, rolling back Composio trigger:', dbError)
      await deleteComposioTrigger(composioTriggerId).catch(console.error)
      return rejected('Failed to save trigger locally')
    }

    globalFeed.publish({ type: 'webhook_trigger_created', triggerId, agentSlug })
    console.log(`[HostTools] Webhook trigger ${triggerId} created (composio: ${composioTriggerId})`)
    const triggerName = input.name || input.trigger_type
    return resolved(
      `Webhook trigger "${triggerName}" created successfully (ID: ${triggerId}).\n\nTrigger type: ${input.trigger_type}\nConnected account: ${input.connected_account_id}\nPrompt: ${input.prompt.substring(0, 100)}${input.prompt.length > 100 ? '...' : ''}\n\nThe trigger is now active and will fire when the event occurs.`,
      [{ type: 'webhook_trigger_created', toolUseId, triggerId, triggerType: input.trigger_type, name: input.name, agentSlug }],
    )
  } catch (error) {
    console.error('[HostTools] Error handling setup_trigger:', error)
    return rejected(`Failed to set up trigger: ${errorMessage(error)}`)
  }
}

export async function listTriggers({ agentSlug }: HostToolRequest): Promise<HostToolResult> {
  try {
    const triggers = await listActiveWebhookTriggers(agentSlug)
    if (triggers.length === 0) return resolved('No active webhook triggers for this agent.')
    return resolved(
      `Active webhook triggers:\n\n${triggers
        .map((t) => {
          const source = t.kind === 'custom'
            ? `URL: ${extractEndpointUrl(t.triggerConfig) ?? '(unknown)'}`
            : `Account: ${t.connectedAccountId}`
          return `- **${t.name || t.triggerType}** (ID: ${t.id})\n  Type: ${t.triggerType}${t.kind === 'custom' ? ' (custom endpoint)' : ''}\n  ${source}\n  Fires: ${t.fireCount} time(s)\n  Prompt: ${t.prompt.substring(0, 80)}${t.prompt.length > 80 ? '...' : ''}`
        })
        .join('\n\n')}`,
    )
  } catch (error) {
    console.error('[HostTools] Error handling list_triggers:', error)
    return rejected(String(error))
  }
}

/** Change the prompt of either kind of trigger, keeping its id and firing history. */
export async function updateTrigger({ agentSlug, toolUseId, input: raw }: HostToolRequest): Promise<HostToolResult> {
  try {
    let input: WebhookTriggerUpdateInput
    try {
      input = updateWebhookTriggerInputSchema.parse(JSON.parse(raw))
    } catch (error) {
      return rejected(`Invalid tool input: ${error instanceof Error ? error.message : 'Invalid tool input'}`)
    }

    const trigger = await getWebhookTrigger(input.trigger_id)
    if (!trigger || trigger.agentSlug !== agentSlug) return rejected(`Trigger ${input.trigger_id} not found`)

    if (!(await updateWebhookTriggerPrompt(input.trigger_id, input.prompt))) {
      return rejected(`Trigger ${input.trigger_id} could not be updated — cancelled triggers are not editable`)
    }

    globalFeed.publish({ type: 'webhook_trigger_updated', triggerId: input.trigger_id, agentSlug })
    return resolved(`Updated the prompt for trigger ${input.trigger_id}. Its ID and firing history were preserved.`, [
      { type: 'webhook_trigger_updated', toolUseId, triggerId: input.trigger_id, agentSlug },
    ])
  } catch (error) {
    console.error('[HostTools] Error handling update_trigger:', error)
    return rejected(`Failed to update trigger: ${errorMessage(error)}`)
  }
}

/** Delete on Composio (or disable the endpoint) and locally. */
export async function cancelTrigger({ agentSlug, toolUseId, input: raw }: HostToolRequest): Promise<HostToolResult> {
  try {
    const input = parseToolInput<{ trigger_id: string }>(raw)
    if (input === undefined) return rejected('Invalid tool input')
    if (!input.trigger_id) return rejected('Missing required field: trigger_id')

    // Scoped to the calling agent, so it can't cancel (and, for a custom
    // endpoint, disable the public URL of) another agent's trigger by id.
    if (!(await cancelWebhookTriggerWithCleanup(input.trigger_id, agentSlug))) {
      return rejected(`Trigger ${input.trigger_id} not found or already cancelled`)
    }

    globalFeed.publish({ type: 'webhook_trigger_cancelled', triggerId: input.trigger_id, agentSlug })
    console.log(`[HostTools] Webhook trigger ${input.trigger_id} cancelled`)
    return resolved(`Trigger ${input.trigger_id} has been cancelled. It will no longer fire webhook events.`, [
      { type: 'webhook_trigger_cancelled', toolUseId, triggerId: input.trigger_id, agentSlug },
    ])
  } catch (error) {
    console.error('[HostTools] Error handling cancel_trigger:', error)
    return rejected(`Failed to cancel trigger: ${errorMessage(error)}`)
  }
}
