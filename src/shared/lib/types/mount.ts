/** Every source a volume can come from. A new source adds its id here. */
export const VOLUME_TYPES = ['local'] as const
export type VolumeType = (typeof VOLUME_TYPES)[number]

/** A volume as stored: `type` picks its implementation, and only that type's schema reads `config`. */
export interface StoredVolume {
  id: string // crypto.randomUUID()
  name: string // the volume appears at /mounts/<name>
  type: VolumeType
  config: unknown
}

/** A volume as the API returns it: no config, only the host folder the card and the bind path need. */
export interface VolumeSummary extends Omit<StoredVolume, 'config'> {
  hostPath: string | null // the volume's folder on the machine that runs the agent, if it has one
}

export interface VolumeSummaryWithHealth extends VolumeSummary {
  health: 'ok' | 'missing'
}
