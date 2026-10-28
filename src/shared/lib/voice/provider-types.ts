export const VOICE_PROVIDERS = ['deepgram', 'openai', 'platform'] as const
export type VoiceProvider = typeof VOICE_PROVIDERS[number]
