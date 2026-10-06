import { z } from 'zod'
import type { StoredVolume } from '@shared/lib/types/mount'
import type { LocalVolumeConfig } from '@shared/lib/volumes/local-mountable-volume'

/**
 * Schema for a single persisted volume in mounts.json.
 * Validated at the file read/write boundary (project convention).
 */
export const storedVolumeSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  config: z.unknown(),
}) satisfies z.ZodType<StoredVolume>

// A row written before volumes had a type is a local folder, named by its container path.
const folderRowSchema = z
  .object({ id: z.string(), hostPath: z.string(), containerPath: z.string() })
  .transform(({ id, hostPath, containerPath }): StoredVolume => {
    const config: LocalVolumeConfig = { path: hostPath }
    return { id, name: containerPath.replace(/^\/mounts\//, ''), type: 'local', config }
  })

export const storedVolumesSchema = z.array(z.union([storedVolumeSchema, folderRowSchema]))
