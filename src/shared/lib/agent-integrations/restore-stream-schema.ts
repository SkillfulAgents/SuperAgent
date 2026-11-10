import { z } from 'zod'

/** Which chat's session to reattach, and the ownership it was scheduled under. */
export const restoreStreamPayloadSchema = z.object({
  integrationId: z.string(),
  externalId: z.string(),
  generation: z.number(),
  sessionId: z.string(),
  /** Who the attempt that failed acted for; a task runs outside that scope. */
  actingUserId: z.string().optional(),
})
export type RestoreStreamPayload = z.infer<typeof restoreStreamPayloadSchema>
