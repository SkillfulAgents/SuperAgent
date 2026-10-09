import { z } from 'zod';

/** Source capabilities cross the boundary; provider configuration stays on the host. */
export const volumesEnvSchema = z.array(z.object({
  volumeId: z.string().regex(/^[A-Za-z0-9_-]+$/),
  // Each name becomes one folder under /mounts, so it must be a single path segment.
  name: z.string().min(1).refine((name) => name !== '.' && name !== '..' && !/[/\\\0]/.test(name)),
  cacheMode: z.enum(['local', 'remote']).default('local'),
  caseInsensitive: z.boolean().optional(),
  ignoreSize: z.boolean().optional(),
  dirCacheSeconds: z.number().int().positive().optional(),
}));

export type ContainerMount = z.infer<typeof volumesEnvSchema>[number];

export const volumeRecoveryManifestSchema = z.object({
  version: z.literal(1),
  volumeId: z.string(),
  mountPath: z.string(),
  createdAt: z.string(),
});
