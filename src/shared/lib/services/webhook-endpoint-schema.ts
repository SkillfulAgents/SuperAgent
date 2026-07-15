import { z } from 'zod'
import { RuntimeOptionsSchema } from '@shared/lib/container/runtime-options'

/**
 * Zod schemas for custom webhook endpoints (agent-minted public URLs on the
 * platform proxy) — validated at the IO boundaries per project convention:
 * tool input before it leaves the host, proxy responses when they come back,
 * and the request envelope carried by CUSTOM_WEBHOOK events.
 */

/** Trigger type stamped on webhook_events rows produced by /v1/hooks/{token}. */
export const CUSTOM_WEBHOOK_TRIGGER_TYPE = 'CUSTOM_WEBHOOK'

/**
 * Verification profile the agent may attach to an endpoint. STRICT on purpose:
 * this validates our own outbound writes (tool input → proxy), so unknown
 * knobs are a bug, not forward compatibility. Mirrors the platform engine
 * (apps/proxy/src/webhooks/verification.ts).
 */
export const verificationProfileSchema = z
  .object({
    algorithm: z.enum(['hmac-sha256', 'hmac-sha1']),
    encoding: z.enum(['hex', 'base64']),
    header: z.string().min(1),
    prefix: z.string().optional(),
    template: z
      .string()
      .refine((t) => t.includes('{body}'), { message: 'template must include {body}' }),
    timestamp_header: z.string().optional(),
    webhook_id_header: z.string().optional(),
    tolerance_secs: z.number().positive().optional(),
    secret: z.string().min(1),
    secret_encoding: z.enum(['utf8', 'base64']).optional(),
  })
  .strict()
  .refine(
    (v) => {
      if (v.secret_encoding !== 'base64') return true
      // The engine decodes with atob after stripping an optional whsec_
      // prefix; anything atob rejects would make every delivery soft-fail
      // to verified:false, so reject it before it reaches the platform.
      try {
        atob(v.secret.replace(/^whsec_/, ''))
        return true
      } catch {
        return false
      }
    },
    { message: 'secret is not valid base64 for secret_encoding=base64' }
  )

export type VerificationProfile = z.infer<typeof verificationProfileSchema>

/**
 * CEL filter expression evaluated by the proxy against each delivery. Only
 * shape-checked here (string, length cap mirroring the platform column
 * constraint) — the platform compiles it at the write boundary and its parser
 * error message is what the agent needs to see, so don't pre-empt it.
 */
export const filterExpressionSchema = z.string().trim().min(1).max(2048)

/**
 * Container tool inputs, validated host-side before anything is minted or
 * stored (the container is not a trusted boundary). Unknown keys are dropped;
 * model/effort/speed reuse the shared runtime-options shape.
 */
export const createWebhookEndpointInputSchema = z.object({
  name: z.string().trim().min(1),
  prompt: z.string().trim().min(1),
  verification: verificationProfileSchema.nullish(),
  filter_exp: filterExpressionSchema.nullish(),
  model: RuntimeOptionsSchema.shape.model,
  effort: RuntimeOptionsSchema.shape.effort,
  speed: RuntimeOptionsSchema.shape.speed,
})

export const updateWebhookEndpointInputSchema = z.object({
  trigger_id: z.string().trim().min(1),
  name: z.string().trim().min(1).optional(),
  // null explicitly clears the profile; absent leaves it untouched.
  verification: verificationProfileSchema.nullable().optional(),
  // null explicitly clears the filter; absent leaves it untouched.
  filter_exp: filterExpressionSchema.nullable().optional(),
})

export const inspectWebhookEventsInputSchema = z.object({
  trigger_id: z.string().trim().min(1),
  limit: z.number().int().min(1).max(50).optional(),
  // When set, dry-run this candidate expression against the recent
  // deliveries instead of just listing them.
  test_filter_exp: filterExpressionSchema.optional(),
})

/**
 * Endpoint object as the proxy returns it. Lenient: newer proxy fields must
 * never break an older app. The signing secret never round-trips back
 * (`verification.has_secret` is the redacted marker).
 */
export const webhookEndpointSchema = z
  .object({
    id: z.string(),
    url: z.string(),
    name: z.string(),
    status: z.string(),
    verification: z.object({ has_secret: z.boolean().optional() }).loose().nullable().optional(),
    filter_exp: z.string().nullable().optional(),
    receive_count: z.number().optional(),
    rejected_count: z.number().optional(),
    last_received_at: z.string().nullable().optional(),
    created_at: z.string().optional(),
  })
  .loose()

export type WebhookEndpoint = z.infer<typeof webhookEndpointSchema>

export const webhookEndpointListSchema = z
  .object({ endpoints: z.array(webhookEndpointSchema) })
  .loose()

/**
 * Request envelope stored in webhook_events.payload by the public ingest
 * route. Lenient so envelope evolution on the proxy never wedges dispatch;
 * only the fields the host actually branches on are required.
 */
export const webhookEnvelopeSchema = z
  .object({
    kind: z.string(), // 'event' | 'handshake'
    handshake_type: z.string().optional(),
    verified: z.boolean(),
    // Filter verdict stamped by ingest when the endpoint has a filter_exp
    // ('passed' | 'filtered' | 'error'; filtered rows never reach dispatch).
    filter: z.object({ outcome: z.string(), error: z.string().optional() }).loose().optional(),
    method: z.string().optional(),
    url: z.string().optional(),
    query: z.record(z.string(), z.string()).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    content_type: z.string().nullable().optional(),
    body: z.string().optional(),
    body_encoding: z.string().optional(), // 'utf8' | 'base64'
    received_at: z.string().optional(),
  })
  .loose()

export type WebhookEnvelope = z.infer<typeof webhookEnvelopeSchema>

/**
 * One stored delivery as the proxy's inspection route returns it
 * (GET /v1/webhook-endpoints/{id}/events). Bodies are previews (capped
 * proxy-side); lenient so proxy evolution never breaks inspection.
 */
export const webhookEndpointEventSchema = z
  .object({
    id: z.string(),
    created_at: z.string(),
    status: z.string(),
    kind: z.string().nullable().optional(),
    verified: z.boolean().optional(),
    filter: z.object({ outcome: z.string(), error: z.string().optional() }).loose().nullable().optional(),
    method: z.string().nullable().optional(),
    content_type: z.string().nullable().optional(),
    headers: z.record(z.string(), z.string()).nullable().optional(),
    query: z.record(z.string(), z.string()).nullable().optional(),
    body: z.string().nullable().optional(),
    body_truncated: z.boolean().optional(),
    body_encoding: z.string().nullable().optional(),
  })
  .loose()

export type WebhookEndpointEvent = z.infer<typeof webhookEndpointEventSchema>

export const webhookEndpointEventsSchema = z
  .object({
    endpoint_id: z.string().optional(),
    filter_exp: z.string().nullable().optional(),
    events: z.array(webhookEndpointEventSchema),
  })
  .loose()

/** Dry-run result from POST /v1/webhook-endpoints/{id}/test-filter. */
export const webhookFilterTestResultSchema = z
  .object({
    filter_exp: z.string(),
    evaluated: z.number(),
    summary: z.object({
      passed: z.number(),
      filtered: z.number(),
      error: z.number(),
      skipped: z.number(),
    }),
    results: z.array(
      z
        .object({
          event_id: z.string(),
          created_at: z.string(),
          stored_status: z.string().optional(),
          outcome: z.string(),
          error: z.string().optional(),
        })
        .loose()
    ),
  })
  .loose()

export type WebhookFilterTestResult = z.infer<typeof webhookFilterTestResultSchema>

/**
 * Local mirror of the endpoint's public URL stored in
 * webhook_triggers.triggerConfig for kind='custom' rows.
 */
export const customTriggerConfigSchema = z
  .object({
    url: z.string(),
    endpointId: z.string().optional(),
  })
  .loose()

/** Read the public URL back out of a custom trigger's triggerConfig JSON. */
export function extractEndpointUrl(triggerConfig: string | null | undefined): string | null {
  if (!triggerConfig) return null
  try {
    const parsed = customTriggerConfigSchema.safeParse(JSON.parse(triggerConfig))
    return parsed.success ? parsed.data.url : null
  } catch {
    return null
  }
}
