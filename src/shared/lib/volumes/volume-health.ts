import type { NotMountedReason, StoredVolume, VolumeSummary } from '@shared/lib/types/mount'
import { WorkspaceFileError } from '@shared/lib/agent-actor/workspace-path'
import { instantiateVolume } from './volume-factory'

export function volumeSummary(row: StoredVolume): VolumeSummary {
  return { id: row.id, name: row.name, type: row.type, hostPath: instantiateVolume(row)?.hostPath ?? null }
}

export async function volumeProblem(row: StoredVolume): Promise<NotMountedReason | null> {
  if (!row.name || row.name === '.' || row.name === '..' || /[/\\\0]/.test(row.name)) return 'invalid name'
  const volume = instantiateVolume(row)
  if (!volume) return 'unreadable'
  try {
    return (await volume.stat('')).kind === 'directory' ? null : 'not found'
  } catch (error) {
    if (error instanceof WorkspaceFileError && error.code === 'not-found') return 'not found'
    if (error instanceof WorkspaceFileError && error.code === 'not-accessible') return 'not accessible'
    return 'unreadable'
  }
}
