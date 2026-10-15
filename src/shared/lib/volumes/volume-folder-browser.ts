import type { z } from 'zod'
import { WorkspaceFileError } from '@shared/lib/agent-actor/workspace-path'
import { VolumeError } from './volume-error'
import { volumeFoldersSchema, type VolumeFolders } from './volume-folders-schema'

export type VolumeSetupViewer = { userId: string | null }
export type VolumeFolderBrowser = (query: unknown, viewer: VolumeSetupViewer) => Promise<VolumeFolders>

/** A type owns its query schema and account authorization. Validate input separately from
 * upstream data so an invalid provider response never becomes a user-input error. */
export function volumeFolderBrowser<Query>(
  schema: z.ZodType<Query>,
  browse: (query: Query, viewer: VolumeSetupViewer) => Promise<VolumeFolders>,
): VolumeFolderBrowser {
  return async (input, viewer) => {
    const query = schema.parse(input)
    try {
      return volumeFoldersSchema.parse(await browse(query, viewer))
    } catch (error) {
      if (error instanceof VolumeError || error instanceof WorkspaceFileError) throw error
      console.error('[volumes] Folder browse failed:', error)
      throw new VolumeError('The drive source is temporarily unavailable. Please try again.', 503)
    }
  }
}
