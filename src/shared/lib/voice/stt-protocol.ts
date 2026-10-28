import type { VoiceProvider } from '../config/settings'

export type SttProtocol = 'deepgram' | 'openai-realtime'

export interface VoiceTokenResponse {
  provider: VoiceProvider
  token: string
  /** Omitted by older hosts; clients derive it with resolveSttProtocol(). */
  protocol?: SttProtocol
}

/** Older hosts omit `protocol`; derive it from the provider id as clients did before. */
export function resolveSttProtocol(credentials: { provider: VoiceProvider; protocol?: SttProtocol }): SttProtocol {
  return credentials.protocol ?? (credentials.provider === 'openai' ? 'openai-realtime' : 'deepgram')
}
