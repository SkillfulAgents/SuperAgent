import { z } from 'zod'

/** One voice a provider can read with. The id is what gets stored and sent back to the provider. */
export interface TtsVoiceInfo {
  id: string
  label: string
  description: string
}

/**
 * Speaking-rate multipliers offered in settings. The schema allows the
 * whole range so a stored value never has to match the presets exactly.
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

/** A stored speed, or the default when there is none or it is out of range. */
export function resolveTtsSpeed(value: unknown): number {
  const parsed = ttsSpeedSchema.safeParse(value)
  return parsed.success ? parsed.data : DEFAULT_TTS_SPEED
}

/** Voice mode plays a soft loop while the agent works, unless turned off. */
export const DEFAULT_HOLD_SOUND = true

/** A stored hold-sound preference, or the default when there is none. */
export function resolveHoldSound(value: unknown): boolean {
  return typeof value === 'boolean' ? value : DEFAULT_HOLD_SOUND
}
