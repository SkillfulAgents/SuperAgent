import { z } from 'zod'

export const localVolumeConfigSchema = z.object({ path: z.string() })
export type LocalVolumeConfig = z.infer<typeof localVolumeConfigSchema>

/** Source configuration at the database/file boundary, independent of drivers. */
export const volumeConfigSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('local'), config: localVolumeConfigSchema }),
])
export type VolumeSource = z.infer<typeof volumeConfigSchema>
