/**
 * Webhook Trigger Tools
 *
 * Tools for managing Composio webhook trigger subscriptions and custom webhook
 * endpoints (dedicated public URLs for services Composio has no trigger for).
 * - get_available_triggers: blocking — returns available trigger types
 * - list_triggers: blocking — returns active triggers/endpoints for this agent
 * - setup_trigger: blocking — message persister handles dual-write, resolves with result
 * - cancel_trigger: blocking — message persister handles dual-delete, resolves with result
 * - create_webhook_endpoint: blocking — mints a public webhook URL on the platform
 * - update_webhook_endpoint: blocking — attaches/updates signature verification
 */

import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { inputManager } from '../input-manager'

/**
 * Generic HMAC verification profile for custom webhook endpoints. Covers ~80%
 * of providers (incl. everything Standard-Webhooks/svix-based: OpenAI,
 * Anthropic, Supabase, ...).
 */
const verificationProfileSchema = z.object({
  algorithm: z.enum(['hmac-sha256', 'hmac-sha1']).describe('HMAC hash algorithm'),
  encoding: z.enum(['hex', 'base64']).describe('How the provider encodes the digest'),
  header: z
    .string()
    .describe('Header carrying the signature (e.g. "X-Hub-Signature-256", "Stripe-Signature")'),
  prefix: z
    .string()
    .optional()
    .describe('Literal prefix to strip from the signature value (e.g. "sha256=", "v0=")'),
  template: z
    .string()
    .describe(
      'Signed-string template; must include {body}. Vars: {body} {timestamp} {webhook_id} {url} {method}. Examples: GitHub/Shopify "{body}", Stripe "{timestamp}.{body}", Slack/Zoom "v0:{timestamp}:{body}", Standard Webhooks "{webhook_id}.{timestamp}.{body}", Square "{url}{body}", HubSpot v3 "{method}{url}{body}{timestamp}"',
    ),
  timestamp_header: z
    .string()
    .optional()
    .describe('Header carrying the replay timestamp (e.g. "X-Slack-Request-Timestamp"). Enables a replay window. Not needed for Stripe (embedded in the signature header).'),
  webhook_id_header: z
    .string()
    .optional()
    .describe('Header carrying the message id for {webhook_id} (default "webhook-id")'),
  tolerance_secs: z.number().optional().describe('Replay tolerance in seconds (default 300)'),
  secret: z.string().describe('The signing secret the provider gave you'),
  secret_encoding: z
    .enum(['utf8', 'base64'])
    .optional()
    .describe('Set "base64" for Standard-Webhooks/svix secrets (whsec_...); default utf8'),
})

/**
 * CEL filter expression — evaluated platform-side per delivery. The teaching
 * text lives in one place so create/update stay in sync.
 */
const FILTER_EXP_DESCRIPTION = `Optional CEL filter expression evaluated against every delivery at the edge; only events where it returns true start a session. Use it whenever the service's webhook subscription is coarser than the actual trigger condition (e.g. Linear sends ALL Issue events — filter to "assigned to me changed") so irrelevant events never wake you. Filtered events are still logged (see inspect_webhook_events), never lost silently.

Context variables: body (parsed JSON body; null when the body is not JSON), headers (lowercased header map), query (query-string map), method, verified (HMAC verification result), content_type.

Rules: the expression must evaluate to a boolean. Guard fields that are not always present with has() — has(body.data.assignee) && body.data.assignee.email == "x" — and headers with in — "x-github-event" in headers && ... — because dereferencing a missing key is an ERROR, and errors FAIL OPEN (the event is delivered with the error recorded). matches() uses JavaScript regex syntax (no (?i) inline flags).

Examples: Linear assignee changed: headers["linear-event"] == "Issue" && body.action == "update" && has(body.updatedFrom.assigneeId) · GitHub issues opened: headers["x-github-event"] == "issues" && body.action == "opened" · Stripe: body.type == "invoice.payment_failed" · Slack mention: body.event.type == "app_mention" · Shopify: headers["x-shopify-topic"] == "orders/create".

Before setting or changing a filter on an endpoint that has already received traffic, dry-run the candidate with inspect_webhook_events (test_filter_exp) against real deliveries.`

export const getAvailableTriggersTool = tool(
  'get_available_triggers',
  `List available webhook triggers for a connected account. Returns trigger types that can fire webhooks (e.g., "new email received", "new GitHub push").

Call this before setup_trigger to discover what triggers are available for a given account.`,
  {
    connected_account_id: z
      .string()
      .describe('The ID of the connected account to list triggers for'),
  },
  async (args) => {
    console.log(`[get_available_triggers] Fetching for account ${args.connected_account_id}`)

    const toolUseId = inputManager.consumeCurrentToolUseId()
    if (!toolUseId) {
      return {
        content: [{ type: 'text' as const, text: 'Unable to process request — no tool use ID available.' }],
        isError: true,
      }
    }

    try {
      // Block until the message persister resolves with trigger data
      const result = await inputManager.createPendingWithType<string>(
        toolUseId,
        'get_available_triggers',
        { connected_account_id: args.connected_account_id },
      )

      return {
        content: [{ type: 'text' as const, text: result }],
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unknown error'
      return {
        content: [{ type: 'text' as const, text: `Failed to fetch available triggers: ${msg}` }],
        isError: true,
      }
    }
  },
)

export const listTriggersTool = tool(
  'list_triggers',
  `List all active webhook triggers and custom webhook endpoints for this agent. Returns trigger IDs, types, connected accounts / public URLs, and prompts.`,
  {},
  async () => {
    console.log('[list_triggers] Fetching active triggers')

    const toolUseId = inputManager.consumeCurrentToolUseId()
    if (!toolUseId) {
      return {
        content: [{ type: 'text' as const, text: 'Unable to process request — no tool use ID available.' }],
        isError: true,
      }
    }

    try {
      const result = await inputManager.createPendingWithType<string>(
        toolUseId,
        'list_triggers',
      )

      return {
        content: [{ type: 'text' as const, text: result }],
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unknown error'
      return {
        content: [{ type: 'text' as const, text: `Failed to list triggers: ${msg}` }],
        isError: true,
      }
    }
  },
)

export const setupTriggerTool = tool(
  'setup_trigger',
  `Set up a webhook trigger on a connected account. When the trigger fires, a new agent session will be created with the specified prompt and the webhook payload.

Use get_available_triggers first to discover what triggers are available for an account.`,
  {
    connected_account_id: z
      .string()
      .describe('The ID of the connected account'),
    trigger_type: z
      .string()
      .describe('The trigger type slug from get_available_triggers (e.g., "GMAIL_NEW_EMAIL")'),
    prompt: z
      .string()
      .describe('What the agent should do when the trigger fires. The webhook payload will be appended automatically.'),
    name: z
      .string()
      .optional()
      .describe('Optional display name for this trigger (e.g., "New email handler")'),
    trigger_config: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('Optional configuration for the trigger (depends on trigger type)'),
    model: z
      .enum(['opus', 'sonnet', 'haiku'])
      .optional()
      .describe('Optional model family to use when this trigger fires. If not specified, uses the global default.'),
    effort: z
      .enum(['low', 'medium', 'high', 'xhigh', 'max'])
      .optional()
      .describe('Optional effort level when this trigger fires. If not specified, uses the global default.'),
  },
  async (args) => {
    console.log(`[setup_trigger] Setting up ${args.trigger_type} trigger`)

    if (!args.prompt.trim()) {
      return {
        content: [{ type: 'text' as const, text: 'Prompt cannot be empty.' }],
        isError: true,
      }
    }

    const toolUseId = inputManager.consumeCurrentToolUseId()
    if (!toolUseId) {
      return {
        content: [{ type: 'text' as const, text: 'Unable to process request — no tool use ID available.' }],
        isError: true,
      }
    }

    try {
      const result = await inputManager.createPendingWithType<string>(
        toolUseId,
        'setup_trigger',
        {
          connected_account_id: args.connected_account_id,
          trigger_type: args.trigger_type,
          prompt: args.prompt,
          name: args.name,
          trigger_config: args.trigger_config,
          model: args.model,
          effort: args.effort,
        },
      )

      return {
        content: [{ type: 'text' as const, text: result }],
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unknown error'
      return {
        content: [{ type: 'text' as const, text: `Failed to set up trigger: ${msg}` }],
        isError: true,
      }
    }
  },
)

export const createWebhookEndpointTool = tool(
  'create_webhook_endpoint',
  `Mint a dedicated public webhook URL for ANY external service — including ones with no Composio trigger. When the service delivers a webhook to the URL, a new agent session runs with your prompt plus the request details.

Returns the public URL. You then register it with the third-party service yourself (via its API or by telling the user where to paste it). Registration handshakes (Slack url_verification, Dropbox/Meta GET challenges, MS Graph validationToken) are answered automatically.

If the service reveals a signing secret only AFTER registration, attach it afterwards with update_webhook_endpoint — until then events are marked unverified. Prefer setup_trigger when a Composio trigger exists for the service.`,
  {
    name: z.string().describe('Display name for this endpoint (e.g. "Vercel deploy hook")'),
    prompt: z
      .string()
      .describe('What the agent should do when a webhook arrives. The request payload will be appended automatically.'),
    verification: verificationProfileSchema
      .optional()
      .describe('Optional HMAC signature verification profile, if you already know the signing secret'),
    filter_exp: z.string().optional().describe(FILTER_EXP_DESCRIPTION),
    model: z
      .enum(['opus', 'sonnet', 'haiku'])
      .optional()
      .describe('Optional model family to use when this endpoint fires. If not specified, uses the global default.'),
    effort: z
      .enum(['low', 'medium', 'high', 'xhigh', 'max'])
      .optional()
      .describe('Optional effort level when this endpoint fires. If not specified, uses the global default.'),
  },
  async (args) => {
    console.log(`[create_webhook_endpoint] Minting endpoint "${args.name}"`)

    if (!args.prompt.trim()) {
      return {
        content: [{ type: 'text' as const, text: 'Prompt cannot be empty.' }],
        isError: true,
      }
    }

    const toolUseId = inputManager.consumeCurrentToolUseId()
    if (!toolUseId) {
      return {
        content: [{ type: 'text' as const, text: 'Unable to process request — no tool use ID available.' }],
        isError: true,
      }
    }

    try {
      const result = await inputManager.createPendingWithType<string>(
        toolUseId,
        'create_webhook_endpoint',
        {
          name: args.name,
          prompt: args.prompt,
          verification: args.verification,
          filter_exp: args.filter_exp,
          model: args.model,
          effort: args.effort,
        },
      )

      return {
        content: [{ type: 'text' as const, text: result }],
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unknown error'
      return {
        content: [{ type: 'text' as const, text: `Failed to create webhook endpoint: ${msg}` }],
        isError: true,
      }
    }
  },
)

export const updateWebhookEndpointTool = tool(
  'update_webhook_endpoint',
  `Update a custom webhook endpoint: attach or change its HMAC signature verification (many services only reveal the signing secret after you register the URL), set or change its delivery filter expression, or rename it. Pass the trigger ID from list_triggers or create_webhook_endpoint.

Once verification is attached, incoming requests with bad signatures are rejected at the edge and valid events are marked verified.`,
  {
    trigger_id: z.string().describe('The trigger ID of the custom webhook endpoint (from list_triggers)'),
    name: z.string().optional().describe('New display name'),
    verification: verificationProfileSchema
      .nullable()
      .optional()
      .describe('HMAC verification profile to attach; pass null to remove verification'),
    filter_exp: z
      .string()
      .nullable()
      .optional()
      .describe(`Pass null to remove the filter (deliver everything). ${FILTER_EXP_DESCRIPTION}`),
  },
  async (args) => {
    console.log(`[update_webhook_endpoint] Updating endpoint for trigger ${args.trigger_id}`)

    const toolUseId = inputManager.consumeCurrentToolUseId()
    if (!toolUseId) {
      return {
        content: [{ type: 'text' as const, text: 'Unable to process request — no tool use ID available.' }],
        isError: true,
      }
    }

    try {
      const result = await inputManager.createPendingWithType<string>(
        toolUseId,
        'update_webhook_endpoint',
        {
          trigger_id: args.trigger_id,
          name: args.name,
          verification: args.verification,
          filter_exp: args.filter_exp,
        },
      )

      return {
        content: [{ type: 'text' as const, text: result }],
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unknown error'
      return {
        content: [{ type: 'text' as const, text: `Failed to update webhook endpoint: ${msg}` }],
        isError: true,
      }
    }
  },
)

export const inspectWebhookEventsTool = tool(
  'inspect_webhook_events',
  `Inspect recent deliveries to a custom webhook endpoint — INCLUDING events the filter expression withheld — and optionally dry-run a candidate filter expression against them.

Use it to answer "why didn't my trigger fire?" (check the stored filter verdicts and any eval errors) and to iterate on a filter safely: pass test_filter_exp to see which of the recent real deliveries a candidate expression would pass/filter/error on, using the exact evaluator that runs at delivery time. The dry run never changes the endpoint; apply the winning expression with update_webhook_endpoint.`,
  {
    trigger_id: z.string().describe('The trigger ID of the custom webhook endpoint (from list_triggers)'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe('How many recent deliveries to inspect (default 20, max 50)'),
    test_filter_exp: z
      .string()
      .optional()
      .describe('Candidate CEL filter expression to dry-run against the recent deliveries'),
  },
  async (args) => {
    console.log(`[inspect_webhook_events] Inspecting trigger ${args.trigger_id}`)

    const toolUseId = inputManager.consumeCurrentToolUseId()
    if (!toolUseId) {
      return {
        content: [{ type: 'text' as const, text: 'Unable to process request — no tool use ID available.' }],
        isError: true,
      }
    }

    try {
      const result = await inputManager.createPendingWithType<string>(
        toolUseId,
        'inspect_webhook_events',
        {
          trigger_id: args.trigger_id,
          limit: args.limit,
          test_filter_exp: args.test_filter_exp,
        },
      )

      return {
        content: [{ type: 'text' as const, text: result }],
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unknown error'
      return {
        content: [{ type: 'text' as const, text: `Failed to inspect webhook events: ${msg}` }],
        isError: true,
      }
    }
  },
)

export const cancelTriggerTool = tool(
  'cancel_trigger',
  `Cancel an active webhook trigger or custom webhook endpoint by ID. This permanently removes the trigger subscription (custom endpoint URLs stop accepting requests).`,
  {
    trigger_id: z
      .string()
      .describe('The trigger ID to cancel (from list_triggers)'),
  },
  async (args) => {
    console.log(`[cancel_trigger] Cancelling trigger ${args.trigger_id}`)

    const toolUseId = inputManager.consumeCurrentToolUseId()
    if (!toolUseId) {
      return {
        content: [{ type: 'text' as const, text: 'Unable to process request — no tool use ID available.' }],
        isError: true,
      }
    }

    try {
      const result = await inputManager.createPendingWithType<string>(
        toolUseId,
        'cancel_trigger',
        { trigger_id: args.trigger_id },
      )

      return {
        content: [{ type: 'text' as const, text: result }],
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unknown error'
      return {
        content: [{ type: 'text' as const, text: `Failed to cancel trigger: ${msg}` }],
        isError: true,
      }
    }
  },
)
