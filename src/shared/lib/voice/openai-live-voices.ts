import type { TtsVoiceInfo } from './tts-preferences'

/**
 * Voices GPT-Live sessions accept under `audio.output.voice`
 * (https://developers.openai.com/api/docs/guides/live-conversations). The
 * read-aloud list (openai-voices.ts) is a different model's; only these are
 * offered where a Live voice is chosen. Marin, first, is the default.
 */
export const OPENAI_LIVE_VOICE_IDS = [
  'marin', 'quartz', 'ripple', 'vesper', 'willow', 'stone', 'gleam',
  'meridian', 'bossa', 'tempo', 'beacon', 'delta', 'cinder',
] as const
export type OpenAILiveVoice = typeof OPENAI_LIVE_VOICE_IDS[number]
export const DEFAULT_OPENAI_LIVE_VOICE: OpenAILiveVoice = 'marin'

export const OPENAI_LIVE_VOICES: readonly TtsVoiceInfo[] = OPENAI_LIVE_VOICE_IDS
  .map(id => ({ id, label: id[0].toUpperCase() + id.slice(1), description: 'OpenAI' }))

export function isOpenAILiveVoice(value: unknown): value is OpenAILiveVoice {
  return typeof value === 'string' && (OPENAI_LIVE_VOICE_IDS as readonly string[]).includes(value)
}

/** The voice a session is created with: the requested one when GPT-Live offers it, else the default. */
export function resolveOpenAILiveVoice(requested: string | undefined): OpenAILiveVoice {
  return isOpenAILiveVoice(requested) ? requested : DEFAULT_OPENAI_LIVE_VOICE
}
