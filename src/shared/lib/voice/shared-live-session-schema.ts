import { z } from 'zod'
import { VOICE_PROVIDERS } from './provider-types'

/** What any process needs to close a Live session another one opened. */
export const sharedLiveSessionSchema = z.object({
  owner: z.string(),
  provider: z.enum(VOICE_PROVIDERS),
  providerSessionId: z.string(),
  closing: z.boolean(),
})

export type SharedLiveSession = z.infer<typeof sharedLiveSessionSchema>
