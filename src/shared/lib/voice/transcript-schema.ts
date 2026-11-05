import { z } from 'zod'

export const transcriptSessionIdSchema = z.string().min(1).max(200).regex(/^[a-zA-Z0-9_-]+$/)
export const voiceTranscriptStartSchema = z.object({ id: z.uuid() })
export const voiceTranscriptRefSchema = z.object({ id: z.uuid(), index: z.number().int().nonnegative(), path: z.string() })
export type VoiceTranscriptRef = z.infer<typeof voiceTranscriptRefSchema>
export const voiceSpeechPieceSchema = z.object({
  at: z.number().min(0).max(8_000_000_000_000), role: z.enum(['user', 'assistant']), text: z.string().min(1).max(2000),
})
export type VoiceSpeechPiece = z.infer<typeof voiceSpeechPieceSchema>
export const voiceSpeechBatchSchema = z.object({
  sentAt: z.number().min(0).max(8_000_000_000_000),
  pieces: z.array(voiceSpeechPieceSchema).min(1).max(500),
})
export type VoiceSpeechBatch = z.infer<typeof voiceSpeechBatchSchema>
export const voiceTranscriptAllocationSchema = z.object({ id: z.uuid() })
