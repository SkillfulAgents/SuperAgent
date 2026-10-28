import { z } from 'zod'
import { githubVolumeConfigSchema } from './github-schema'
import { s3VolumeConfigSchema } from './s3-schema'
import { dropboxVolumeConfigSchema } from './dropbox-schema'
import { googleDriveVolumeConfigSchema } from './google-drive-schema'

/**
 * A folder by its real path. `bookmark` is the security-scoped bookmark the
 * Mac App Store build's open panel makes when the person picks the folder: the
 * sandbox reads the folder only through it (`local-folder-access.ts`).
 */
export const localVolumeConfigSchema = z.object({ path: z.string(), bookmark: z.string().min(1).optional() })
export type LocalVolumeConfig = z.infer<typeof localVolumeConfigSchema>

/** A Gamut drive: the platform's id for an org drive. Setup picks or makes the drive first, then saves its id.
 * No keys and no location: both come with each set of keys, so the platform can move it. */
export const platformVolumeIdSchema = z.string().regex(/^vol_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
// Not strict: a definition may still carry the location it was first saved with. The keys' location wins.
export const storedPlatformVolumeConfigSchema = z.object({ volumeId: platformVolumeIdSchema })
export type StoredPlatformVolumeConfig = z.infer<typeof storedPlatformVolumeConfigSchema>

/** Source configuration at the database/file boundary, independent of drivers. */
export const volumeConfigSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('github'), config: githubVolumeConfigSchema }),
  z.object({ type: z.literal('s3'), config: s3VolumeConfigSchema }),
  z.object({ type: z.literal('local'), config: localVolumeConfigSchema }),
  z.object({ type: z.literal('dropbox'), config: dropboxVolumeConfigSchema }),
  z.object({ type: z.literal('googledrive'), config: googleDriveVolumeConfigSchema }),
  z.object({ type: z.literal('platform'), config: storedPlatformVolumeConfigSchema }),
])
export type VolumeSource = z.infer<typeof volumeConfigSchema>
