import type { NotMountedReason, StoredVolume, VolumeSummary, VolumeSummaryWithHealth } from '@shared/lib/types/mount'
import { WorkspaceFileError } from '@shared/lib/agent-actor/workspace-path'
import { VolumePreparingError } from './volume-error'
import { instantiateVolume } from './volume-factory'
import { LocalMountableVolume } from './local-mountable-volume'

export function volumeSummary(row: StoredVolume): VolumeSummary {
  const volume = instantiateVolume(row)
  return {
    id: row.id, name: row.name, type: row.type, hostPath: volume?.hostPath ?? null,
    ...(volume?.sourceLabel ? { sourceLabel: volume.sourceLabel } : {}),
    ...(volume?.readOnly ? { sourceReadOnly: true } : {}),
    ...(volume?.attention ? { attention: volume.attention } : {}),
  }
}

/** A preparing reason that carries an error is a failed first copy, so it reads as missing. */
export function volumeHealth(reason: NotMountedReason | null): VolumeSummaryWithHealth['health'] {
  return reason === null ? 'ok' : reason === 'preparing' ? 'preparing' : 'missing'
}

export async function volumeProblem(row: StoredVolume, agentSlug?: string): Promise<NotMountedReason | null> {
  if (!row.name || row.name === '.' || row.name === '..' || /[/\\\0]/.test(row.name)) return 'invalid name'
  const volume = instantiateVolume(row, agentSlug)
  if (!volume) return 'unreadable'
  // The sandbox lost the folder: nothing to fix in it, only the pick to make again.
  if (volume instanceof LocalMountableVolume && !volume.opens()) return 'pick the folder again'
  try {
    return (await volume.health()).kind === 'directory' ? null : 'not found'
  } catch (error) {
    if (error instanceof VolumePreparingError) return error.reason ? `preparing: ${error.reason}` : 'preparing'
    if (error instanceof WorkspaceFileError && error.code === 'not-found') return 'not found'
    if (error instanceof WorkspaceFileError && error.code === 'not-accessible') return 'not accessible'
    return 'unreadable'
  }
}
