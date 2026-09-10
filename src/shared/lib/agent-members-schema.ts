import { z } from 'zod'
import { avatarOverrideSchema, providerImageSchema } from './user-profile-schema'

export const agentMemberSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  image: z.union([avatarOverrideSchema, providerImageSchema]).nullable(),
  role: z.enum(['owner', 'user', 'viewer']),
})
export const agentMembersSchema = z.array(agentMemberSchema)
export type AgentMember = z.infer<typeof agentMemberSchema>

// Invalidation hints only. Member details always come from an authorized GET.
export const collaborationEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('agent_members_changed'), agentSlug: z.string().min(1) }),
  z.object({ type: z.literal('agent_access_revoked'), agentSlug: z.string().min(1) }),
  z.object({ type: z.literal('user_profile_changed'), userId: z.string().min(1) }),
])
export type CollaborationEvent = z.infer<typeof collaborationEventSchema>
