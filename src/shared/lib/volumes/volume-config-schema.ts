import { z } from 'zod'
import { s3LocationSchema, s3VolumeConfigSchema } from './s3-schema'
import { dropboxVolumeConfigSchema } from './dropbox-schema'
import { googleDriveVolumeConfigSchema } from './google-drive-schema'

export const localVolumeConfigSchema = z.object({ path: z.string() })
export type LocalVolumeConfig = z.infer<typeof localVolumeConfigSchema>

/** A Gamut drive: the platform's id for an org drive. Setup sends an existing drive's id, or a name to
 * create one; saving adds where it lives. No keys. */
const volumeId = z.string().regex(/^vol_[0-9a-f-]{36}$/)
export const storedPlatformVolumeConfigSchema = s3LocationSchema.extend({ volumeId }).strict()
export const platformVolumeConfigSchema = z.union([
  storedPlatformVolumeConfigSchema,
  z.object({ volumeId }).strict(),
  // The platform owns the name rules and answers with its own message.
  z.object({ name: z.string().trim().min(1) }).strict(),
])
export type PlatformVolumeConfig = z.infer<typeof platformVolumeConfigSchema>
export type StoredPlatformVolumeConfig = z.infer<typeof storedPlatformVolumeConfigSchema>

/** Source configuration at the database/file boundary, independent of drivers. */
export const volumeConfigSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('s3'), config: s3VolumeConfigSchema }),
  z.object({ type: z.literal('local'), config: localVolumeConfigSchema }),
  z.object({ type: z.literal('dropbox'), config: dropboxVolumeConfigSchema }),
  z.object({ type: z.literal('googledrive'), config: googleDriveVolumeConfigSchema }),
  z.object({ type: z.literal('platform'), config: platformVolumeConfigSchema }),
])
export type VolumeSource = z.infer<typeof volumeConfigSchema>
