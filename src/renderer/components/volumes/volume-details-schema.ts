import { z } from 'zod'
import { volumeNameSchema } from '@shared/lib/services/mount-schema'

export const volumeDetailsSchema = z.object({
  name: z.string().trim().pipe(volumeNameSchema),
  visibility: z.enum(['private', 'public']),
})
export type VolumeDetails = z.infer<typeof volumeDetailsSchema>
