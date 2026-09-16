import { z } from 'zod'

export const voiceHistorySchema = z.array(z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().max(4000),
})).max(24)
export type VoiceHistory = z.infer<typeof voiceHistorySchema>

/** Ephemeral spoken words, distinct from the agent's written responses. */
export interface VoiceTranscriptEntry {
  role: 'user' | 'assistant'
  text: string
}

export type VoiceConversationEngine = 'chained' | 'openai-live'
