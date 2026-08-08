import { z } from 'zod'

export const DashboardPackageSchema = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
    gamut: z
      .object({
        upstreamPath: z.enum(['stripped', 'mounted']).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()
