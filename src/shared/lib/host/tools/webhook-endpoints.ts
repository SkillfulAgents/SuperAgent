/**
 * The custom webhook endpoint host tools: mint a public URL on the webhook
 * relay, attach verification or a delivery filter to it, and inspect the
 * deliveries it received.
 *
 * Custom endpoints gate on the relay being available, not on Composio mode:
 * they live on the relay and keep working with a personal Composio key.
 * Never log or report the tool input: it can carry the endpoint's HMAC secret.
 */
import type { HostToolRequest, HostToolResult } from '@shared/lib/agent-actor/host-port'
import { globalFeed } from '@shared/lib/notifications/global-feed'
import { captureException } from '@shared/lib/error-reporting'
import { attribution } from '@shared/lib/platform-attribution'
import { getWebhookRelay, webhooksUnavailableMessage } from '@shared/lib/webhook-relay'
import {
  createWebhookTrigger,
  getWebhookTrigger,
  resolvePlatformMemberForCandidates,
  updateWebhookTriggerName,
} from '@shared/lib/services/webhook-trigger-service'
import {
  CUSTOM_WEBHOOK_TRIGGER_TYPE,
  createWebhookEndpointInputSchema,
  inspectWebhookEventsInputSchema,
  updateWebhookEndpointInputSchema,
  type VerificationProfile,
  type WebhookEndpointEvent,
} from '@shared/lib/services/webhook-endpoint-schema'
import type { z } from 'zod'
import { errorMessage, parseToolInput, rejected, resolved, sessionOwnerOf } from './host-tool-result'
import { resolvePlatformMemberForSession } from './platform-member'

// One inspection line per stored delivery. Bodies are already previews (the
// relay caps them at 2KB); cap harder here: this text lands in the agent's
// context, and 50 events × 2KB would crowd out the actual work.
const INSPECT_BODY_PREVIEW_CHARS = 200

export function formatWebhookEventLine(event: WebhookEndpointEvent): string {
  const filterNote = event.filter
    ? ` · filter: ${event.filter.outcome}${event.filter.outcome === 'error' && event.filter.error ? ` (${event.filter.error})` : ''}`
    : ''
  const kindNote = event.kind === 'handshake' ? ' · handshake' : ''
  const verifiedNote = event.kind === 'event' ? (event.verified ? ' · verified' : ' · unverified') : ''
  const body = typeof event.body === 'string' && event.body
    ? event.body.slice(0, INSPECT_BODY_PREVIEW_CHARS) +
      (event.body.length > INSPECT_BODY_PREVIEW_CHARS || event.body_truncated ? '…' : '')
    : '(empty body)'
  return `- ${event.id} · ${event.created_at} · ${event.status}${kindNote}${verifiedNote}${filterNote}\n  ${event.method ?? 'POST'} ${event.content_type ?? ''} — ${body}`
}

/** The tool input validated against its schema, or the rejection to send instead. */
function parseWith<T>(schema: z.ZodType<T>, raw: string): { input: T } | { rejection: HostToolResult } {
  const json = parseToolInput<unknown>(raw)
  if (json === undefined) return { rejection: rejected('Invalid tool input') }
  const parsed = schema.safeParse(json)
  if (!parsed.success) {
    return {
      rejection: rejected(
        `Invalid tool input: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}`,
      ),
    }
  }
  return { input: parsed.data }
}

/**
 * The member an existing endpoint's calls act as: whoever minted it, not
 * whoever created the session that runs the call (SUP-765). Rows from before
 * the minting column fall back to the trigger's creator, then the session's member.
 */
async function endpointMember(
  trigger: { mintedByMemberId?: string | null; createdByUserId?: string | null },
  agentSlug: string,
  sessionId: string,
): Promise<string> {
  return (
    trigger.mintedByMemberId ??
    (await resolvePlatformMemberForCandidates([trigger.createdByUserId]))?.memberId ??
    (await resolvePlatformMemberForSession(agentSlug, sessionId))
  )
}

/** Mint the endpoint on the relay and save its trigger row; a failed save disables the endpoint again. */
export async function createWebhookEndpoint({ agentSlug, sessionId, toolUseId, input: raw }: HostToolRequest): Promise<HostToolResult> {
  try {
    const unavailable = webhooksUnavailableMessage('Custom webhook endpoints')
    if (unavailable) return rejected(unavailable)

    const parsed = parseWith(createWebhookEndpointInputSchema, raw)
    if ('rejection' in parsed) return parsed.rejection
    const { input } = parsed
    const verification = input.verification ?? undefined
    const filterExp = input.filter_exp ?? undefined

    const memberId = await resolvePlatformMemberForSession(agentSlug, sessionId)
    // Minted explicitly as `token::memberId` below, so record that when no
    // ALS attribution is active; never persist the opaque-key 'local' placeholder.
    const mintedByMemberId =
      (await attribution.current())?.actingMemberId() ?? (memberId === 'local' ? undefined : memberId)

    const endpoint = await getWebhookRelay().createEndpoint(memberId, {
      name: input.name.trim(),
      ...(verification ? { verification } : {}),
      ...(filterExp ? { filterExp } : {}),
    })

    let triggerId: string
    try {
      triggerId = await createWebhookTrigger({
        agentSlug,
        kind: 'custom',
        composioTriggerId: endpoint.id,
        triggerType: CUSTOM_WEBHOOK_TRIGGER_TYPE,
        // The public URL lives on the relay; mirroring it here spares the
        // list and the UI a round trip.
        triggerConfig: JSON.stringify({ url: endpoint.url, endpointId: endpoint.id }),
        prompt: input.prompt,
        name: input.name.trim(),
        createdBySessionId: sessionId,
        createdByUserId: await sessionOwnerOf(agentSlug, sessionId),
        mintedByMemberId,
        model: input.model,
        effort: input.effort,
        speed: input.speed,
      })
    } catch (dbError) {
      console.error('[HostTools] SQLite save failed, disabling platform endpoint:', dbError)
      captureException(dbError, {
        tags: { area: 'webhook-endpoints', op: 'create-local-save' },
        extra: { endpointId: endpoint.id, agentSlug, sessionId },
      })
      await getWebhookRelay().disableEndpoint(memberId, endpoint.id).catch((rollbackError) => {
        // Minted, not saved, and now not disabled either: a live public URL
        // is orphaned with no local row. The loudest signal there is.
        console.error('[HostTools] Endpoint rollback failed — endpoint orphaned live:', rollbackError)
        captureException(rollbackError, {
          tags: { area: 'webhook-endpoints', op: 'create-rollback' },
          extra: { endpointId: endpoint.id, agentSlug, sessionId, memberId },
        })
      })
      return rejected('Failed to save trigger locally')
    }

    globalFeed.publish({ type: 'webhook_trigger_created', triggerId, agentSlug })
    console.log(`[HostTools] Custom webhook endpoint ${endpoint.id} created (trigger: ${triggerId})`)
    return resolved(
      `Webhook endpoint "${input.name}" created (trigger ID: ${triggerId}).\n\n` +
        `Public URL: ${endpoint.url}\n\n` +
        `Next: register this URL with the third-party service. Do the registration YOURSELF whenever possible — in order of preference:\n` +
        `1. The service's API: use the connected account through the authenticated proxy, or call it directly (request_secret for an API key if needed).\n` +
        `2. Offer to do it via the browser (navigate to the service's webhook settings page and fill it in).\n` +
        `3. Only if the user prefers to do it themselves (or registration requires access you don't have): give them a precise, copy-pasteable walkthrough — the exact settings path for that service, the URL to paste, the content type to pick, which events to enable, and where to put the signing secret.\n\n` +
        `Registration handshakes (Slack url_verification, Dropbox/Meta challenges, MS Graph validationToken) are answered automatically.\n\n` +
        `${verification
          ? 'Signature verification is configured — events with bad signatures are rejected at the edge.'
          : 'No signature verification is configured yet — events will be marked UNVERIFIED. If the service provides a signing secret (many reveal it only after registration), attach it with update_webhook_endpoint.'}\n\n` +
        `${filterExp
          ? `Delivery filter active: only events matching \`${filterExp}\` start a session (filtered events are logged — inspect_webhook_events shows them). After real traffic arrives, verify the filter behaves with inspect_webhook_events.`
          : 'No delivery filter is set — EVERY event this URL receives will start a session. After registering, decide whether you need one: compare the events the service will actually send against what your prompt handles. If the subscription is broader (it usually is — most services can\'t filter by assignee/status/type at registration), add a CEL filter_exp via update_webhook_endpoint so irrelevant events are dropped at the edge instead of waking you. Once real deliveries exist, dry-run candidates with inspect_webhook_events (test_filter_exp) before applying.'}\n\n` +
        `Every delivery to this URL starts a session with your prompt plus the request details.`,
      [{ type: 'webhook_trigger_created', toolUseId, triggerId, triggerType: CUSTOM_WEBHOOK_TRIGGER_TYPE, name: input.name, agentSlug }],
    )
  } catch (error) {
    console.error('[HostTools] Error handling create_webhook_endpoint:', error)
    // The agent sees the reject; report it too, so a recurring relay
    // regression surfaces in aggregate.
    captureException(error, {
      tags: { area: 'webhook-endpoints', op: 'create' },
      extra: { agentSlug, sessionId, toolUseId },
    })
    return rejected(`Failed to create webhook endpoint: ${errorMessage(error)}`)
  }
}

/** Rename an endpoint, or attach or remove its verification or filter (verification usually follows registration). */
export async function updateWebhookEndpoint({ agentSlug, sessionId, toolUseId, input: raw }: HostToolRequest): Promise<HostToolResult> {
  try {
    const unavailable = webhooksUnavailableMessage('Custom webhook endpoints')
    if (unavailable) return rejected(unavailable)

    const parsed = parseWith(updateWebhookEndpointInputSchema, raw)
    if ('rejection' in parsed) return parsed.rejection
    const { input } = parsed

    const trigger = await getWebhookTrigger(input.trigger_id)
    if (!trigger || trigger.agentSlug !== agentSlug || trigger.kind !== 'custom' || !trigger.composioTriggerId) {
      return rejected(`No custom webhook endpoint found for trigger ${input.trigger_id}`)
    }
    if (trigger.status === 'cancelled') {
      return rejected(`Trigger ${input.trigger_id} is cancelled; create a new endpoint instead`)
    }

    const patch: { name?: string; verification?: VerificationProfile | null; filter_exp?: string | null } = {}
    if (input.name) patch.name = input.name
    if (input.verification !== undefined) patch.verification = input.verification
    if (input.filter_exp !== undefined) patch.filter_exp = input.filter_exp
    if (Object.keys(patch).length === 0) {
      return rejected('Nothing to update: pass name, verification, and/or filter_exp')
    }

    const memberId = await endpointMember(trigger, agentSlug, sessionId)
    await getWebhookRelay().updateEndpoint(memberId, trigger.composioTriggerId, {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.verification !== undefined ? { verification: patch.verification } : {}),
      ...(patch.filter_exp !== undefined ? { filterExp: patch.filter_exp } : {}),
    })

    // Keep the local row in step, so the list and the UI don't show a stale name.
    if (patch.name) await updateWebhookTriggerName(trigger.id, patch.name)

    const changed = [
      patch.name ? 'name' : null,
      patch.verification === null ? 'verification removed' : patch.verification ? 'verification attached' : null,
      patch.filter_exp === null ? 'filter removed' : patch.filter_exp ? 'filter set' : null,
    ].filter(Boolean).join(', ')
    console.log(`[HostTools] Custom webhook endpoint ${trigger.composioTriggerId} updated (${changed})`)
    return resolved(
      `Webhook endpoint updated (${changed}).${patch.verification
        ? ' Incoming requests are now signature-verified at the edge; events with bad signatures are rejected.'
        : ''}${patch.filter_exp
        ? ` Only deliveries matching \`${patch.filter_exp}\` will start a session; non-matching ones are logged as filtered (inspect_webhook_events shows them, including any filter eval errors — errors fail open and still deliver).`
        : patch.filter_exp === null
          ? ' The delivery filter was removed — every event starts a session again.'
          : ''}`,
    )
  } catch (error) {
    console.error('[HostTools] Error handling update_webhook_endpoint:', error)
    captureException(error, {
      tags: { area: 'webhook-endpoints', op: 'update' },
      extra: { agentSlug, sessionId, toolUseId },
    })
    return rejected(`Failed to update webhook endpoint: ${errorMessage(error)}`)
  }
}

/**
 * The endpoint's recent deliveries (including those its filter withheld), or
 * a dry run of a candidate filter against them. Changes nothing anywhere.
 */
export async function inspectWebhookEvents({ agentSlug, sessionId, toolUseId, input: raw }: HostToolRequest): Promise<HostToolResult> {
  try {
    const unavailable = webhooksUnavailableMessage('Custom webhook endpoints')
    if (unavailable) return rejected(unavailable)

    const parsed = parseWith(inspectWebhookEventsInputSchema, raw)
    if ('rejection' in parsed) return parsed.rejection
    const { input } = parsed

    // A cancelled endpoint stays inspectable on purpose: its stored events
    // outlive it, and a post-mortem is a legitimate use.
    const trigger = await getWebhookTrigger(input.trigger_id)
    if (!trigger || trigger.agentSlug !== agentSlug || trigger.kind !== 'custom' || !trigger.composioTriggerId) {
      return rejected(`No custom webhook endpoint found for trigger ${input.trigger_id}`)
    }

    const memberId = await endpointMember(trigger, agentSlug, sessionId)
    let result: string
    if (input.test_filter_exp) {
      const dryRun = await getWebhookRelay().testEndpointFilter(memberId, trigger.composioTriggerId, input.test_filter_exp, input.limit)
      const lines = dryRun.results.map((r) => {
        const stored = r.stored_status ? ` (stored: ${r.stored_status})` : ''
        const detail = r.outcome === 'error' && r.error ? ` — ${r.error}` : ''
        return `- ${r.event_id} · ${r.created_at}${stored}: ${r.outcome.toUpperCase()}${detail}`
      })
      result =
        `Dry-run of \`${dryRun.filter_exp}\` against the ${dryRun.evaluated} most recent deliveries — ` +
        `${dryRun.summary.passed} would pass, ${dryRun.summary.filtered} filtered out, ` +
        `${dryRun.summary.error} errored (errors fail open = delivered), ${dryRun.summary.skipped} skipped (handshakes/scrubbed).\n\n` +
        `${lines.length ? lines.join('\n') : 'No stored deliveries to evaluate yet — send a test event first.'}\n\n` +
        `Nothing was changed. When the verdicts look right, apply it with update_webhook_endpoint (filter_exp).`
    } else {
      const { filterExp, events } = await getWebhookRelay().listEndpointEvents(memberId, trigger.composioTriggerId, input.limit)
      result =
        `Active filter: ${filterExp ? `\`${filterExp}\`` : 'none (every event delivers)'}\n\n` +
        `${events.length
          ? `Recent deliveries (newest first):\n${events.map(formatWebhookEventLine).join('\n')}`
          : 'No deliveries recorded yet for this endpoint.'}`
    }
    console.log(`[HostTools] Inspected webhook events for ${trigger.composioTriggerId}`)
    return resolved(result)
  } catch (error) {
    console.error('[HostTools] Error handling inspect_webhook_events:', error)
    captureException(error, {
      tags: { area: 'webhook-endpoints', op: 'inspect' },
      extra: { agentSlug, sessionId, toolUseId },
    })
    return rejected(`Failed to inspect webhook events: ${errorMessage(error)}`)
  }
}
