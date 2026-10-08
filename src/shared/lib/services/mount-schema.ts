import { z } from 'zod'
import type { StoredVolume } from '@shared/lib/types/mount'
import type { LocalVolumeConfig } from '@shared/lib/volumes/volume-config-schema'

// A row written before volumes had a type is a local folder, named by its container path.
const folderRowSchema = z
  .object({ id: z.string(), hostPath: z.string(), containerPath: z.string() })
  .transform(({ id, hostPath, containerPath }): StoredVolume => {
    const config: LocalVolumeConfig = { path: hostPath }
    return { id, name: containerPath.replace(/^\/mounts\//, ''), type: 'local', config }
  })

/** mounts.json as a list of rows, each parsed on its own so a row this version cannot read costs only itself. */
export const mountsFileSchema = z.array(z.unknown())

export const volumeNameSchema = z.string().min(1).max(255)
  .refine(name => name !== '.' && name !== '..' && !/[/\\\0]/.test(name), 'Use a single folder name')

export const createVolumeSchema = z.object({
  type: z.string(),
  config: z.unknown(),
  name: volumeNameSchema.optional(),
  visibility: z.enum(['private', 'public']).optional(),
}).strict()

export const updateVolumeSchema = z.object({
  name: volumeNameSchema,
  visibility: z.enum(['private', 'public']).optional(),
}).strict()

export const addMountSchema = z.union([
  z.object({ volumeId: z.string().min(1), restart: z.boolean().optional() }).strict(),
  createVolumeSchema.extend({ restart: z.boolean().optional() }),
])

/** Preserve future source types during import without interpreting their config. */
export const legacyVolumeRowSchema = z.union([
  z.object({ id: z.string().min(1), name: z.string(), type: z.string(), config: z.json() }),
  folderRowSchema,
])
