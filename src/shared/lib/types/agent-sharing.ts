import { z } from 'zod'
import { agentAvatarSchema } from './agent-avatar'

export const memberAgentRoleSchema = z.enum(['user', 'viewer'])
export type MemberAgentRole = z.infer<typeof memberAgentRoleSchema>
const memberAgentSchema = z.object({
  slug: z.string(),
  name: z.string(),
  avatar: agentAvatarSchema,
  role: memberAgentRoleSchema,
  canMessage: z.boolean(),
})
export type MemberAgent = z.infer<typeof memberAgentSchema>
export const agentShareRosterSchema = z.object({ direct: z.array(memberAgentSchema), global: z.array(memberAgentSchema) })
export type AgentShareRoster = z.infer<typeof agentShareRosterSchema>
export const directMemberAgentsSchema = z.record(z.string(), z.array(memberAgentSchema))
