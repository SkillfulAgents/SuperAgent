import { z } from 'zod'

export const DashboardPackageSchema = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
    dependencies: z.record(z.string(), z.string()).optional(),
    devDependencies: z.record(z.string(), z.string()).optional(),
    workspaces: z
      .union([
        z.array(z.string()),
        z.object({ packages: z.array(z.string()).optional() }).passthrough(),
      ])
      .optional(),
    gamut: z
      .object({
        upstreamPath: z.enum(['stripped', 'mounted']).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()

export const DashboardInstallDepsSchema = DashboardPackageSchema.pick({
  dependencies: true,
  devDependencies: true,
  workspaces: true,
})

export const InstalledPackageManifestSchema = z
  .object({
    name: z.string().min(1),
    bin: z.union([z.string(), z.record(z.string(), z.string())]).optional(),
  })
  .passthrough()

export type InstalledPackageManifest = z.infer<typeof InstalledPackageManifestSchema>
