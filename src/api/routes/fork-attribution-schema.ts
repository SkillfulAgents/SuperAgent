import { z } from 'zod'

/** A user line in a forked transcript: the SDK stamps the old uuid on every copied line. */
export const forkedUserLineSchema = z
  .object({
    type: z.literal('user'),
    uuid: z.string().min(1),
    forkedFrom: z.object({ sessionId: z.string(), messageUuid: z.string().min(1) }),
  })
  .loose()
