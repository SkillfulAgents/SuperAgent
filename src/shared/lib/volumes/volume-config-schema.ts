import { z } from 'zod'
import { dropboxVolumeConfigSchema } from './dropbox-schema'
import { googleDriveVolumeConfigSchema } from './google-drive-schema'

export const localVolumeConfigSchema = z.object({ path: z.string() })
export type LocalVolumeConfig = z.infer<typeof localVolumeConfigSchema>

/** Source configuration at the database/file boundary, independent of drivers. */
export const volumeConfigSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('local'), config: localVolumeConfigSchema }),
  z.object({ type: z.literal('dropbox'), config: dropboxVolumeConfigSchema }),
  z.object({ type: z.literal('googledrive'), config: googleDriveVolumeConfigSchema }),
])
export type VolumeSource = z.infer<typeof volumeConfigSchema>
