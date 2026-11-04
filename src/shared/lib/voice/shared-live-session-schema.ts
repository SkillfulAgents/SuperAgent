import { z } from 'zod'
import { VOICE_PROVIDERS } from './provider-types'

/** What any process needs to close a Live session another one opened. */
export const sharedLiveSessionSchema = z.object({
  owner: z.string(),
  provider: z.enum(VOICE_PROVIDERS),
  providerSessionId: z.string(),
  /** The key the session was opened with: a hang-up anywhere closes it with that key. */
  apiKey: z.string().optional(),
  closing: z.boolean(),
})

export type SharedLiveSession = z.infer<typeof sharedLiveSessionSchema>
