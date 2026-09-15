import { z } from 'zod'

import { voiceHistorySchema } from './conversation-types'
export { voiceHistorySchema, type VoiceHistory, type VoiceTranscriptEntry } from './conversation-types'

export const liveMappingSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('request'),
    history: voiceHistorySchema,
    transcript: z.string().min(1).max(16000),
    previousRequest: z.string().max(4000),
    agentBusy: z.boolean(),
  }),
  z.object({ kind: z.literal('reply'), text: z.string().min(1).max(12000) }),
])
export type LiveMappingInput = z.infer<typeof liveMappingSchema>

export const liveRequestSchema = z.object({
  action: z.enum(['message', 'cancel', 'clarify', 'none']),
  text: z.string().max(4000),
})
export type LiveRequest = z.infer<typeof liveRequestSchema>

export interface LiveSessionAnswer {
  session: { id: string }
  transport: { type: 'webrtc'; sdp: string }
}
