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

/** A volume as the API returns it: no config, only the host folder the card shows. */
export interface VolumeSummary extends Omit<StoredVolume, 'config'> {
  hostPath: string | null // the volume's folder on the machine that runs the agent, if it has one
}

export interface VolumeSummaryWithHealth extends VolumeSummary {
  health: 'ok' | 'missing'
}

/** The saved definition available in Settings and the attachment picker. */
export interface VolumeDefinitionSummary extends VolumeSummaryWithHealth {
  userId: string | null
  canManage: boolean
  attachmentCount: number
}

/** An agent's attachment, whose id and name are independent of the definition. */
export interface MountedVolume extends StoredVolume {
  volumeId: string
}

export interface MountSummaryWithHealth extends VolumeSummaryWithHealth {
  volumeId: string
}

/** Source latency determines the container cache policy, independently of its provider. */
export type VolumeCacheMode = 'local' | 'remote'

/** A volume as the container receives it, in SUPERAGENT_VOLUMES. */
export interface ContainerVolume {
  volumeId: string // attachment id; the agent token scopes its lookup
  name: string
  /** Older hosts omit this; the image preserves local-folder behavior in that case. */
  cacheMode?: VolumeCacheMode
  caseInsensitive?: boolean
}

/** Why a volume is not in the container. */
export type NotMountedReason =
  | 'not found'
  | 'not accessible'
  | 'unreadable'
  | 'invalid name'
  | 'not supported here'
  | 'start failed with folders'
  | 'failed in the agent'
  | 'not confirmed'

/** A volume the container does not have, with why. */
export interface NotMountedVolume {
  name: string
  reason: NotMountedReason
}
