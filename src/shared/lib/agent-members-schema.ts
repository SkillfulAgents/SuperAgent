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

// Bound each read; larger sidebars are split into chunks by the client.
export const MAX_AGENT_MEMBERS_BATCH_SIZE = 100
export const agentMembersBatchRequestSchema = z.object({
  agentSlugs: z.array(z.string().min(1).max(255)).min(1).max(MAX_AGENT_MEMBERS_BATCH_SIZE),
})
export const agentMembersByAgentSchema = z.record(z.string(), agentMembersSchema)
export const agentMembersBatchResponseSchema = z.record(z.string(), z.discriminatedUnion('status', [
  z.object({ status: z.literal(200), members: agentMembersSchema }),
  z.object({ status: z.literal(403) }),
  z.object({ status: z.literal(404) }),
]))

// Invalidation hints only. Member details always come from an authorized roster read.
export const collaborationEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('agent_members_changed'), agentSlug: z.string().min(1) }),
  z.object({ type: z.literal('agent_access_revoked'), agentSlug: z.string().min(1) }),
])
export type CollaborationEvent = z.infer<typeof collaborationEventSchema>
