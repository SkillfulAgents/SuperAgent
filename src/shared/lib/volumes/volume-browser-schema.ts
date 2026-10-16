import { z } from 'zod'

/** Browser paths are relative to one definition, never host or workspace paths. */
export const volumeBrowseSchema = z.object({
  path: z.string().max(4096).refine(path =>
    !path.startsWith('/') && !/[\\\0]/.test(path) && !path.split('/').some(part => part === '.' || part === '..'),
  'Invalid volume path').default(''),
})
