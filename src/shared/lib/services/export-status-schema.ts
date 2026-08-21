import { z } from 'zod'

export const hostExportStatusSchema = z.object({
  inProgress: z.boolean(),
})

export type HostExportStatus = z.infer<typeof hostExportStatusSchema>
