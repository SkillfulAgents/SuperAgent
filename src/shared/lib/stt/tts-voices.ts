import { z } from 'zod'

/**
 * Text-to-speech voices the app offers. Deepgram Aura-2 only for now — the
 * voice id doubles as the `model` query parameter on the speak endpoint.
 * Kept to a curated handful so the settings picker stays scannable; the
 * full catalogue is at https://developers.deepgram.com/docs/tts-models.
 */
export const TTS_VOICES = [
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
] as const

export type TtsVoice = (typeof TTS_VOICES)[number]['id']

export const DEFAULT_TTS_VOICE: TtsVoice = 'aura-2-thalia-en'

const voiceIds = TTS_VOICES.map((v) => v.id) as [TtsVoice, ...TtsVoice[]]
export const ttsVoiceSchema = z.enum(voiceIds)

export function isTtsVoice(value: unknown): value is TtsVoice {
  return ttsVoiceSchema.safeParse(value).success
}
