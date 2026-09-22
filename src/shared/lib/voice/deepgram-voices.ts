import type { TtsVoiceInfo } from './tts-preferences'

/**
 * Deepgram Aura-2 voices offered for reading replies aloud. The id doubles
 * as the `model` query parameter on the speak endpoint. Kept to a curated
 * handful so the settings picker stays scannable; the full catalogue is at
 * https://developers.deepgram.com/docs/tts-models. Shared by the direct
 * Deepgram provider and the platform provider, which proxies to Deepgram.
 */
export const DEEPGRAM_TTS_VOICES: readonly TtsVoiceInfo[] = [
  { id: 'aura-2-thalia-en', label: 'Thalia', description: 'Clear, confident, energetic' },
  { id: 'aura-2-andromeda-en', label: 'Andromeda', description: 'Casual, expressive, comfortable' },
  { id: 'aura-2-athena-en', label: 'Athena', description: 'Calm, smooth, professional' },
  { id: 'aura-2-luna-en', label: 'Luna', description: 'Friendly, natural, engaging' },
  { id: 'aura-2-pandora-en', label: 'Pandora', description: 'Smooth, calm, British' },
  { id: 'aura-2-apollo-en', label: 'Apollo', description: 'Confident, comfortable, casual' },
  { id: 'aura-2-arcas-en', label: 'Arcas', description: 'Natural, smooth, clear' },
  { id: 'aura-2-orion-en', label: 'Orion', description: 'Approachable, calm, polite' },
  { id: 'aura-2-draco-en', label: 'Draco', description: 'Warm, trustworthy, British baritone' },
  { id: 'aura-2-zeus-en', label: 'Zeus', description: 'Deep, trustworthy, smooth' },
]
