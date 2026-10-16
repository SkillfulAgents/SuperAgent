import { z } from 'zod'
import { DEFAULT_MEETING_MODE, meetingIntegrationSettingsSchema, type MeetingIntegrationSettings, type MeetingMode } from '../schemas'

/**
 * What an installation stores. Credentials are not part of it: Recall is
 * reached through the platform proxy (or a host-wide key, see transport.ts),
 * so one agent's integration holds only the family's per-installation
 * settings: how it presents itself in calls and how it takes part in them.
 */
export const recallConfigSchema = meetingIntegrationSettingsSchema.strict()
export type RecallConfig = z.infer<typeof recallConfigSchema>

const SETTING_KEYS = ['botName', 'instructions', 'mode', 'voice'] as const

/** A settings PATCH: `null` clears a field, an absent key leaves it alone. */
export const recallSettingsPatchSchema = z.object({
  botName: recallConfigSchema.shape.botName.unwrap().nullable().optional(),
  instructions: recallConfigSchema.shape.instructions.unwrap().nullable().optional(),
  mode: recallConfigSchema.shape.mode.unwrap().nullable().optional(),
  voice: recallConfigSchema.shape.voice.unwrap().nullable().optional(),
}).strict()

/** What the renderer sees of an installation's configuration. */
export interface RecallSettings { botName: string | null; instructions: string | null; mode: MeetingMode; voice: string | null }

export function parseRecallConfig(value: string): RecallConfig {
  try {
    // Spike-era rows carried credentials; they are ignored, not rejected. Empty strings read as unset.
    const stored = z.object({
      botName: z.string().optional(), instructions: z.string().optional(), mode: z.string().optional(), voice: z.string().optional(),
    }).loose().parse(JSON.parse(value))
    const config: Record<string, string> = {}
    for (const key of SETTING_KEYS) if (stored[key]) config[key] = stored[key]
    return recallConfigSchema.parse(config)
  } catch { throw new Error('Invalid stored Recall.ai configuration') }
}

/**
 * A settings PATCH applied to a stored row, for the service's config merge:
 * `null` clears a field, absent keys keep their value, unknown keys are refused.
 */
export function mergeRecallConfig(stored: string, patch: Record<string, unknown>): RecallConfig {
  const current = parseRecallConfig(stored)
  const change = recallSettingsPatchSchema.parse(patch)
  const next: MeetingIntegrationSettings = { ...current }
  for (const key of SETTING_KEYS) {
    const value = change[key]
    if (value === undefined) continue
    if (value === null) delete next[key]
    else (next as Record<string, string>)[key] = value
  }
  return recallConfigSchema.parse(next)
}

/** The stored configuration as settings; a row that fails to parse reads as unset rather than failing the page. */
export function recallSettingsOf(config: string): RecallSettings {
  let parsed: RecallConfig = {}
  try { parsed = parseRecallConfig(config) } catch { parsed = {} }
  return { botName: parsed.botName ?? null, instructions: parsed.instructions ?? null, mode: parsed.mode ?? DEFAULT_MEETING_MODE, voice: parsed.voice ?? null }
}
