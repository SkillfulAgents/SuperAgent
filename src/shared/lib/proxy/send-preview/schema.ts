import { z } from 'zod'

/**
 * A decoded send, as the approval card receives it. `kind` names what is sent (an email, a chat message) and
 * `look` the service whose UI draws it. Each kind validates its own `data` where a look draws it.
 */
export const sendPreviewSchema = z.object({
  kind: z.string(),
  look: z.string(),
  /** The card's title, in place of the endpoint description. */
  title: z.string(),
  data: z.unknown(),
})

export type SendPreview = z.infer<typeof sendPreviewSchema>
