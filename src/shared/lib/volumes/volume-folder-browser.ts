import type { z } from 'zod'
import { WorkspaceFileError } from '@shared/lib/agent-actor/workspace-path'
import { VolumeError } from './volume-error'
import { createdVolumeFolderSchema, volumeFoldersSchema, type CreatedVolumeFolder, type VolumeFolders } from './volume-folders-schema'

export type VolumeSetupViewer = { userId: string | null }
export type VolumeFolderBrowser = (query: unknown, viewer: VolumeSetupViewer) => Promise<VolumeFolders>
export type VolumeFolderCreator = (input: unknown, viewer: VolumeSetupViewer) => Promise<CreatedVolumeFolder>

/** A type owns its query schema and account authorization. Validate input separately from
 * upstream data so an invalid provider response never becomes a user-input error. */
function volumeSetupCall<Query, Result>(schema: z.ZodType<Query>, result: z.ZodType<Result>,
  run: (query: Query, viewer: VolumeSetupViewer) => Promise<Result>): (input: unknown, viewer: VolumeSetupViewer) => Promise<Result> {
  return async (input, viewer) => {
    const query = schema.parse(input)
    try {
      return result.parse(await run(query, viewer))
    } catch (error) {
      if (error instanceof VolumeError || error instanceof WorkspaceFileError) throw error
      console.error('[volumes] Setup call failed:', error)
      throw new VolumeError('The drive source is temporarily unavailable. Please try again.', 503)
    }
  }
}

export function volumeFolderBrowser<Query>(schema: z.ZodType<Query>, browse: (query: Query, viewer: VolumeSetupViewer) => Promise<VolumeFolders>): VolumeFolderBrowser {
  return volumeSetupCall(schema, volumeFoldersSchema, browse)
}

export function volumeFolderCreator<Query>(schema: z.ZodType<Query>, create: (query: Query, viewer: VolumeSetupViewer) => Promise<CreatedVolumeFolder>): VolumeFolderCreator {
  return volumeSetupCall(schema, createdVolumeFolderSchema, create)
}
