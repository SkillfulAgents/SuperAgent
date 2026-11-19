import { z } from 'zod'

// The part of electron-updater's pending/update-info.json we read: the file
// name of the download it describes.
export const pendingUpdateInfoSchema = z.object({
  fileName: z.string().min(1),
})
