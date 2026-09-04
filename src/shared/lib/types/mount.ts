export interface AgentMount {
  id: string // crypto.randomUUID() for a folder, the volume id for a shared volume
  hostPath: string // absolute host path
  containerPath: string // e.g. /mounts/project or /volumes/team-brain
  folderName: string // basename for a folder, display name for a shared volume
  addedAt: string // ISO date
}

/** Which registry a record came from. Read by the card only; never by the pipe. */
export type MountSource = 'folder' | 'shared'

export interface MountRecord extends AgentMount {
  source: MountSource
  health: 'ok' | 'missing'
}
