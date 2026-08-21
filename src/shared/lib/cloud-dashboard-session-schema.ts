import { z } from 'zod'

export const CloudDashboardSessionSchema = z.object({
  useCloudOrigin: z.boolean(),
  origin: z.string().nullable(),
})

export type CloudDashboardSession = z.infer<typeof CloudDashboardSessionSchema>
