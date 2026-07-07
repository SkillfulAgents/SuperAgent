import { z } from 'zod'

// Envelope contract for frames arriving on the container→host session stream.
// Validates only the fields the host's stream machinery consumes — `type` for
// routing, and the cursor fields introduced by the lossless-replay protocol:
// `seq` (per-epoch position, stamped by the container at store time; absent on
// broadcast frames) and the attach hello's `epoch`/`max_seq`. The SDK message
// payload itself is passed through untouched (loose): its shape is the SDK's
// contract, consumed field-by-field downstream.
export const streamEnvelopeSchema = z.looseObject({
  type: z.string(),
  seq: z.int().nonnegative().optional(),
  epoch: z.string().optional(),
  max_seq: z.int().gte(-1).optional(),
})

export type StreamEnvelope = z.infer<typeof streamEnvelopeSchema>
