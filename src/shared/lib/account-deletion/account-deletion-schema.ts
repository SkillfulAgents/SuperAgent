import { z } from 'zod'

/**
 * Account ids as they may enter the deletion event: UUIDs, numeric ids and
 * server prefixes. Content, URLs and emails cannot, and nothing shaped like an
 * API key.
 */
export const opaqueIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_.:-]+$/)
  .refine((value) => !value.toLowerCase().startsWith('sk-'))

/**
 * One account's deletion request, stored before it is sent so that a retry
 * (after a timeout, an error, a restart) sends the same request and never a
 * second one. `acceptedAt` is set once Amplitude acknowledged the event.
 */
export const accountDeletionRecordSchema = z.object({
  requestId: z.string().uuid(),
  /** Unix milliseconds of the confirmation; unchanged on retry. */
  requestedAt: z.number().int().nonnegative(),
  userId: opaqueIdSchema,
  tenantId: opaqueIdSchema.nullable(),
  workspaceUrl: z.string().url().max(1024),
  acceptedAt: z.number().int().nonnegative().nullable(),
})

export type AccountDeletionRecord = z.infer<typeof accountDeletionRecordSchema>

/** Amplitude HTTP V2's success body. Anything else is not an acknowledgement. */
export const amplitudeAcknowledgementSchema = z.object({
  code: z.literal(200),
  events_ingested: z.literal(1),
})

/** What the Account screen sees of a request: never the account or tenant ids. */
export const accountDeletionStatusSchema = z.object({
  /** Whether this install has an account whose deletion can be requested here. */
  available: z.boolean(),
  request: z
    .object({
      requestId: z.string(),
      requestedAt: z.number(),
      accepted: z.boolean(),
    })
    .nullable(),
})

export type AccountDeletionStatus = z.infer<typeof accountDeletionStatusSchema>
