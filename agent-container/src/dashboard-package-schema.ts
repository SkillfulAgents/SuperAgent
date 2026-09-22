import { z } from 'zod'

// Every directory under /workspace/artifacts carries a package.json. Whether
// it is a dashboard, a widget, or both is decided by artifact-kind.ts; this
// schema reads only the dashboard-side fields.
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
