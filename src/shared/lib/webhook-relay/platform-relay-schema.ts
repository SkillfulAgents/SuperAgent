import { z } from 'zod'

/**
 * Responses from the platform proxy's `/v1/webhook-events` routes. Loose, so a
 * field the proxy adds later doesn't fail every claim.
 */

export const platformRealtimeConfigSchema = z
  .object({
    url: z.string().min(1),
    apikey: z.string().min(1),
    jwt: z.string().min(1),
    channel: z.string(),
    table: z.string().optional(),
  })
  .loose()

// `composio_trigger_id` holds the endpoint id for both Composio trigger
// instances (ti_…) and agent-minted endpoints (whep_…).
export const platformRelayEventSchema = z
  .object({
    id: z.string().min(1),
    composio_trigger_id: z.string().min(1),
    trigger_type: z.string(),
    payload: z.unknown(),
    created_at: z.string(),
  })
  .loose()

// Rows are validated one by one so a single malformed row can't discard the
// rest of an already-claimed batch.
export const platformClaimResponseSchema = z
  .object({
    events: z.array(z.unknown()),
    realtime: platformRealtimeConfigSchema.nullable().optional(),
  })
  .loose()

/** The realtime INSERT record fields the relay reads to decide whether to wake. */
export const platformRealtimeRecordSchema = z
  .object({
    composio_trigger_id: z.string().optional(),
    status: z.string().optional(),
  })
  .loose()
