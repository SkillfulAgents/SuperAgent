import { z } from 'zod'
import { agentAvatarSchema } from '@shared/lib/types/agent-avatar'
import { RuntimeOptionsSchema } from '@shared/lib/container/runtime-options'

export const creationDraftSchema = z.object({
  agent: z.object({ slug: z.string(), displaySlug: z.string() }).optional(),
  requestId: z.string().uuid().optional(),
  sessionRequestId: z.string().uuid().optional(),
  identity: z.object({ name: z.string(), avatar: agentAvatarSchema }),
  stage: z.enum(['name', 'describe', 'addons']),
  prompt: z.string(),
  dreamSelected: z.boolean().optional(),
  runtimeOptions: RuntimeOptionsSchema.optional(),
})
export type ChosenAgentIdentity = z.infer<typeof creationDraftSchema>['identity']
export type CreationDraft = z.infer<typeof creationDraftSchema>
