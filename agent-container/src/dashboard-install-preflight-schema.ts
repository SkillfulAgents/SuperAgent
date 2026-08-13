import { z } from 'zod'

export const DashboardInstallManifestSchema = z
  .object({
    dependencies: z.record(z.string(), z.string()).optional(),
    devDependencies: z.record(z.string(), z.string()).optional(),
  })
  .passthrough()

export const InstalledPackageManifestSchema = z
  .object({
    name: z.string().min(1),
    bin: z.union([z.string(), z.record(z.string(), z.string())]).optional(),
  })
  .passthrough()

export type DashboardInstallManifest = z.infer<typeof DashboardInstallManifestSchema>
export type InstalledPackageManifest = z.infer<typeof InstalledPackageManifestSchema>
