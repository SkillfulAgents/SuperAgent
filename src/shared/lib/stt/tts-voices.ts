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

/**
 * Speaking-rate multipliers offered in settings. Deepgram accepts 0.7–1.5;
 * the schema allows that whole range so a stored value never has to match
 * the presets exactly.
 */
export const TTS_SPEEDS = [
  { value: 0.8, label: '0.8×' },
  { value: 0.9, label: '0.9×' },
  { value: 1, label: 'Normal' },
  { value: 1.1, label: '1.1×' },
  { value: 1.2, label: '1.2×' },
  { value: 1.3, label: '1.3×' },
  { value: 1.5, label: '1.5×' },
] as const

export const DEFAULT_TTS_SPEED = 1

export const ttsSpeedSchema = z.number().min(0.7).max(1.5)

/** The voice a deployment reads with for anyone who hasn't picked their own. */
export function resolveDeploymentTtsVoice(deployment: { ttsVoice?: unknown } | undefined): TtsVoice {
  return isTtsVoice(deployment?.ttsVoice) ? deployment.ttsVoice : DEFAULT_TTS_VOICE
}

export interface TtsPreferences {
  voice: TtsVoice
  speed: number
}

/**
 * The voice and speed a request should use: the user's own choices, then
 * the deployment's default voice, then the built-in default. Invalid stored
 * values (a voice removed from the catalogue) fall through the same way.
 */
export function resolveTtsPreferences(
  user: { ttsVoice?: unknown; ttsSpeed?: unknown } | undefined,
  deployment: { ttsVoice?: unknown } | undefined,
): TtsPreferences {
  const voice = isTtsVoice(user?.ttsVoice) ? user.ttsVoice : resolveDeploymentTtsVoice(deployment)
  const speed = ttsSpeedSchema.safeParse(user?.ttsSpeed)
  return { voice, speed: speed.success ? speed.data : DEFAULT_TTS_SPEED }
}
