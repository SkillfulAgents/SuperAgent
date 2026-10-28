import { z } from 'zod'

/** Setup folder IDs are opaque to the shared picker: a source may use paths or remote IDs. */
export const volumeFoldersSchema = z.object({
  folders: z.array(z.object({ id: z.string().min(1), name: z.string() })),
})
export type VolumeFolders = z.infer<typeof volumeFoldersSchema>
