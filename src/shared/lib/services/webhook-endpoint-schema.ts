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
 * Container tool inputs, validated host-side before anything is minted or
 * stored (the container is not a trusted boundary). Unknown keys are dropped;
 * model/effort reuse the shared runtime-options shape.
 */
export const createWebhookEndpointInputSchema = z.object({
  name: z.string().trim().min(1),
  prompt: z.string().trim().min(1),
  verification: verificationProfileSchema.nullish(),
  model: RuntimeOptionsSchema.shape.model,
  effort: RuntimeOptionsSchema.shape.effort,
})

export const updateWebhookEndpointInputSchema = z.object({
  trigger_id: z.string().trim().min(1),
  name: z.string().trim().min(1).optional(),
  // null explicitly clears the profile; absent leaves it untouched.
  verification: verificationProfileSchema.nullable().optional(),
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
