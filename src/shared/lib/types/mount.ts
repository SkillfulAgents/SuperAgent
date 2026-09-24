export interface AgentMount {
  id: string // crypto.randomUUID()
  hostPath: string // absolute host path
  containerPath: string // e.g. /mounts/project
  folderName: string // basename
  addedAt: string // ISO date
}

export interface AgentMountWithHealth extends AgentMount {
  health: 'ok' | 'missing'
}

/** GET /api/agents/:id/mounts. `sharedVolumes` is present only where the server takes shared volumes. */
export interface AgentMountsResponse {
  mounts: AgentMountWithHealth[]
  sharedVolumes?: string[]
}
