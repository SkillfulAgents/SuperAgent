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

export const mountRecordSchema = agentMountSchema.extend({
  source: z.enum(['folder', 'shared']),
  health: z.enum(['ok', 'missing']),
})

export const agentMountsResponseSchema = z.object({
  hostFolders: z.boolean(),
  sharedVolumes: z.boolean(),
  mounts: z.array(mountRecordSchema),
})

export const sharedVolumeListItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  mountName: z.string(),
  attachedAgents: z.array(z.object({ slug: z.string(), name: z.string() })),
})

export const sharedVolumeListResponseSchema = z.object({
  volumes: z.array(sharedVolumeListItemSchema),
})
