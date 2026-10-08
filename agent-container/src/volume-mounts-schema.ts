import { z } from 'zod';

/** Only cache policy crosses the boundary; provider configuration stays on the host. */
export const volumesEnvSchema = z.array(z.object({
  volumeId: z.string().regex(/^[A-Za-z0-9_-]+$/),
  // Each name becomes one folder under /mounts, so it must be a single path segment.
  name: z.string().min(1).refine((name) => name !== '.' && name !== '..' && !/[/\\\0]/.test(name)),
  cacheMode: z.enum(['local', 'remote']).default('local'),
}));

export type ContainerMount = z.infer<typeof volumesEnvSchema>[number];
