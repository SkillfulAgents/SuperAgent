import type { VoiceProvider } from '../config/settings'

export type SttProtocol = 'deepgram' | 'openai-realtime'

export interface VoiceTokenResponse {
  provider: VoiceProvider
  token: string
  protocol: SttProtocol
}
