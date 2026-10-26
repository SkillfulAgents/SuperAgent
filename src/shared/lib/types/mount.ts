/** Every source a volume can come from. A new source adds its id here. */
export const VOLUME_TYPES = ['local', 'dropbox', 'googledrive', 's3', 'platform', 'github'] as const
export type VolumeType = (typeof VOLUME_TYPES)[number]

/** A volume as stored: `type` picks its implementation, and only that type's schema reads `config`. */
export interface StoredVolume {
  id: string // crypto.randomUUID()
  name: string // the volume appears at /mounts/<name>
  type: VolumeType
  config: unknown
}

/** Changes that have not reached the source. */
export interface VolumeAttention {
  badge?: { label: string; tone: 'warning' | 'error' } // shown in place of the health badge
  detail?: string // the badge's tooltip
  unsynced: number // files a delete of the drive would lose
}

/** A volume as the API returns it: no config, only the host folder the card shows. */
export interface VolumeSummary extends Omit<StoredVolume, 'config'> {
  sourceLabel?: string // display-only description for remote sources
  sourceReadOnly?: boolean // the source itself refuses writes, whatever the attachment says
  attention?: VolumeAttention
  hostPath: string | null // the volume's folder on the machine that runs the agent, if it has one
}

export interface VolumeSummaryWithHealth extends VolumeSummary {
  health: 'ok' | 'preparing' | 'missing'
}

export type GlobalAccess = 'read' | 'write'

/** The saved definition available in Settings and the attachment picker. */
export interface VolumeDefinitionSummary extends VolumeSummaryWithHealth {
  userId: string | null
  canManage: boolean
  attachmentCount: number
  globalAccess: GlobalAccess | null
}

/** An agent's attachment, whose id and name are independent of the definition. */
export interface MountedVolume extends StoredVolume {
  volumeId: string
  volumeName: string
  readOnly: boolean
  global?: true // from the drive's global setting, not an attachment row
}

export interface MountSummaryWithHealth extends VolumeSummaryWithHealth {
  volumeId: string
  volumeName: string
  readOnly: boolean
  global?: true
}

/** Source latency determines the container cache policy, independently of its provider. */
export type VolumeCacheMode = 'local' | 'remote'

/** A volume as the container receives it, in SUPERAGENT_VOLUMES. */
export interface ContainerVolume {
  volumeId: string // attachment id; the agent token scopes its lookup
  name: string
  /** The name people see. Older hosts omit it, and the prompt shows the folder name. */
  volumeName?: string
  /** Older hosts omit this; the image preserves local-folder behavior in that case. */
  cacheMode?: VolumeCacheMode
  /** Lets rclone recognize aliases of the same file before replacing a target. */
  caseInsensitive?: boolean
  /** Lets rclone keep a file whose stored size differs from the bytes it sent. */
  ignoreSize?: boolean
  /** How long rclone trusts a folder listing. Older hosts omit it, and the cache policy's default applies. */
  dirCacheSeconds?: number
  /** Older hosts omit this, and the volume mounts read and write. */
  readOnly?: boolean
}

/** Why a volume is not in the container. */
export type NotMountedReason =
  | 'preparing'
  | `preparing: ${string}`
  | 'not found'
  | 'not accessible'
  /** A local drive whose folder the App Sandbox can no longer open. */
  | 'pick the folder again'
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
