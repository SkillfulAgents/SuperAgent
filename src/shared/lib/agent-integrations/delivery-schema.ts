import { z } from 'zod'

/** Durable payloads are JSON; families validate/decode their own payload on use. */
export const deliveryEnvelopeSchema = z.object({
  event: z.object({ type: z.literal('input'), id: z.string().min(1), externalId: z.string().min(1), timestamp: z.coerce.date(), payload: z.json() }),
  route: z.object({ externalId: z.string().min(1), displayName: z.string().optional(), interactionId: z.string().optional(),
    replyTarget: z.record(z.string(), z.string()).optional(), action: z.enum(['run', 'reset', 'ignore']), notice: z.string().optional() }),
})

export class InvalidDeliveryEnvelope extends Error {}
export function parseDeliveryEnvelope(json: string | null) {
  try { return deliveryEnvelopeSchema.parse(JSON.parse(json ?? 'null')) }
  catch (error) { throw new InvalidDeliveryEnvelope('Invalid stored integration input', { cause: error }) }
}
