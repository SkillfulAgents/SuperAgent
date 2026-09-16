import type { TtsVoiceInfo } from './tts-preferences'

// Keep Marin first as the default, matching the Live conversation voice.
export const OPENAI_TTS_VOICES: readonly TtsVoiceInfo[] = [
  'marin', 'cedar', 'alloy', 'ash', 'ballad', 'coral', 'echo',
  'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse',
].map(id => ({ id, label: id[0].toUpperCase() + id.slice(1), description: 'OpenAI' }))
