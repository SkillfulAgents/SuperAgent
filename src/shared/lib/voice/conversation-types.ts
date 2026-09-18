import { z } from 'zod'

// GPT-Live `input` accepts at most 128 messages; the host trims to its token budget.
export const VOICE_HISTORY_MAX_MESSAGES = 128
export const VOICE_HISTORY_MAX_MESSAGE_CHARS = 4000

export const voiceHistorySchema = z.array(z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().max(VOICE_HISTORY_MAX_MESSAGE_CHARS),
})).max(VOICE_HISTORY_MAX_MESSAGES)
export type VoiceHistory = z.infer<typeof voiceHistorySchema>

/** Ephemeral spoken words, distinct from the agent's written responses. */
export interface VoiceTranscriptEntry {
  role: 'user' | 'assistant'
  text: string
}

export type VoiceConversationEngine = 'chained' | 'openai-live'
