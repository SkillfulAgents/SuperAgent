import { z } from 'zod'
import { VOLUME_TYPES, type StoredVolume } from '@shared/lib/types/mount'
import type { LocalVolumeConfig } from '@shared/lib/volumes/local-mountable-volume'

/**
 * Schema for a single stored volume in mounts.json, applied per row at the file
 * boundary. A row it refuses is skipped on read and written back as it was.
 */
export const storedVolumeSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(VOLUME_TYPES),
  config: z.unknown(),
}) satisfies z.ZodType<StoredVolume>

// A row written before volumes had a type is a local folder, named by its container path.
const folderRowSchema = z
  .object({ id: z.string(), hostPath: z.string(), containerPath: z.string() })
  .transform(({ id, hostPath, containerPath }): StoredVolume => {
    const config: LocalVolumeConfig = { path: hostPath }
    return { id, name: containerPath.replace(/^\/mounts\//, ''), type: 'local', config }
  })

/** One row of mounts.json: a stored volume, or a folder row from before types. */
export const storedVolumeRowSchema = z.union([storedVolumeSchema, folderRowSchema])

/** The id and name of any row with them, a row of a type this version does not know included. */
export const rowIdentitySchema = z.object({ id: z.string(), name: z.string() })

/** mounts.json as a list of rows, each parsed on its own so a row this version cannot read costs only itself. */
export const mountsFileSchema = z.array(z.unknown())
