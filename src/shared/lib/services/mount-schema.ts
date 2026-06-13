import { z } from 'zod'
import type { AgentMount } from '@shared/lib/types/mount'

/**
 * Schema for a single persisted mount entry in mounts.json.
 * Validated at the file read/write boundary (project convention).
 */
export const agentMountSchema = z.object({
  id: z.string(),
  hostPath: z.string(),
  containerPath: z.string(),
  folderName: z.string(),
  addedAt: z.string(),
}) satisfies z.ZodType<AgentMount>

export const agentMountsSchema = z.array(agentMountSchema)
