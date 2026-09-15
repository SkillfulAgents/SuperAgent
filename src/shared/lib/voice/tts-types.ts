import { z } from 'zod'
import type { VoiceProvider } from '../config/settings'
import { ttsSpeedSchema } from './tts-preferences'

export type TtsConnection = { transport: 'websocket'; token: string } | { transport: 'http' }
export interface TtsSession {
  provider: VoiceProvider
  connection: TtsConnection
  voice: string
  speed: number
}

export const ttsSynthesisSchema = z.object({
  provider: z.enum(['openai', 'deepgram', 'platform']),
  text: z.string().trim().min(1).max(4096),
  voice: z.string().min(1).max(100),
  speed: ttsSpeedSchema.default(1),
})
export type TtsSynthesisInput = Omit<z.infer<typeof ttsSynthesisSchema>, 'provider'>

/** Server-side synthesis emits raw signed little-endian, 16-bit mono PCM at 24 kHz. */
export interface TtsSynthesisProvider {
  synthesizeSpeech(input: TtsSynthesisInput, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>>
}
