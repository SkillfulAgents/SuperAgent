import { z } from 'zod'
import { volumeNameSchema } from '@shared/lib/services/mount-schema'

/** Setup folder IDs are opaque to the shared picker: a source may use paths or remote IDs. */
const volumeFolderSchema = z.object({ id: z.string().min(1), name: z.string() })
export const volumeFoldersSchema = z.object({
  folders: z.array(volumeFolderSchema),
})
export type VolumeFolders = z.infer<typeof volumeFoldersSchema>

/** A folder made from the picker, named by the source so the picker selects exactly that one. */
export const createdVolumeFolderSchema = z.object({ folder: volumeFolderSchema })
export type CreatedVolumeFolder = z.infer<typeof createdVolumeFolderSchema>

/** A new folder's or drive's name: a drive's name rule, on the trimmed name. */
export const volumeFolderNameSchema = z.string().trim().min(1, 'Enter a name').pipe(volumeNameSchema)

/** Why a name can't be used, or null when it can. */
export function folderNameError(name: string): string | null {
  const checked = volumeFolderNameSchema.safeParse(name)
  return checked.success ? null : checked.error.issues[0].message
}
