import { z } from 'zod'
import { volumeNameSchema } from '@shared/lib/services/mount-schema'
import { githubVolumeConfigSchema } from './github-schema'
import { s3VolumeConfigSchema } from './s3-schema'
import { dropboxVolumeConfigSchema } from './dropbox-schema'
import { googleDriveVolumeConfigSchema } from './google-drive-schema'

export const localVolumeConfigSchema = z.object({ path: z.string() })
export type LocalVolumeConfig = z.infer<typeof localVolumeConfigSchema>

/** A Gamut drive: the platform's id for an org drive. Setup sends an existing drive's id, or a name to
 * create one. No keys and no location: both come with each set of keys, so the platform can move it. */
export const platformVolumeIdSchema = z.string().regex(/^vol_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
// Not strict: a definition may still carry the location it was first saved with. The keys' location wins.
export const storedPlatformVolumeConfigSchema = z.object({ volumeId: platformVolumeIdSchema })
export const platformVolumeConfigSchema = z.union([
  storedPlatformVolumeConfigSchema,
  // The name becomes the drive's folder in every agent: checked here, before the platform creates it.
  z.object({ name: z.string().trim().pipe(volumeNameSchema) }).strict(),
])
export type PlatformVolumeConfig = z.infer<typeof platformVolumeConfigSchema>
export type StoredPlatformVolumeConfig = z.infer<typeof storedPlatformVolumeConfigSchema>

/** Source configuration at the database/file boundary, independent of drivers. */
export const volumeConfigSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('github'), config: githubVolumeConfigSchema }),
  z.object({ type: z.literal('s3'), config: s3VolumeConfigSchema }),
  z.object({ type: z.literal('local'), config: localVolumeConfigSchema }),
  z.object({ type: z.literal('dropbox'), config: dropboxVolumeConfigSchema }),
  z.object({ type: z.literal('googledrive'), config: googleDriveVolumeConfigSchema }),
  z.object({ type: z.literal('platform'), config: platformVolumeConfigSchema }),
])
export type VolumeSource = z.infer<typeof volumeConfigSchema>
