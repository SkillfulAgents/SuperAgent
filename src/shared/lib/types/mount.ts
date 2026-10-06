/** A volume as stored: `type` picks its implementation, and only that type's schema reads `config`. */
export interface StoredVolume {
  id: string // crypto.randomUUID()
  name: string // the volume appears at /mounts/<name>
  type: string
  config: unknown
}

/** A volume as the API returns it: no config, only the host folder the card and the bind path need. */
export interface VolumeSummary extends Omit<StoredVolume, 'config'> {
  hostPath: string | null // the volume's folder on the machine that runs the agent, if it has one
}

export interface VolumeSummaryWithHealth extends VolumeSummary {
  health: 'ok' | 'missing'
}
