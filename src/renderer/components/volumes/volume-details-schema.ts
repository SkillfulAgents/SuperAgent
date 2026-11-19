import { z } from 'zod'
import { volumeNameSchema } from '@shared/lib/services/mount-schema'

export const volumeDetailsSchema = z.object({
  name: z.string().trim().pipe(volumeNameSchema),
  visibility: z.enum(['private', 'public']),
})
export type VolumeDetails = z.infer<typeof volumeDetailsSchema>

export function parseVolumeName(name: string): string {
  const result = volumeDetailsSchema.shape.name.safeParse(name)
  if (!result.success) throw new Error(result.error.issues[0].message)
  return result.data
}
