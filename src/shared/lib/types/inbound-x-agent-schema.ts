import { z } from 'zod'
import { agentAvatarSchema } from './agent-avatar'

export const inboundXAgentCallerSchema = z.object({
  slug: z.string(),
  displaySlug: z.string(),
  name: z.string(),
  /** May this agent send messages here: without asking, or with a person's approval each time. */
  decision: z.enum(['allow', 'review']),
  /** May it read this agent's sessions and files. Older deployments omit it. */
  readDecision: z.enum(['allow', 'review', 'block']).optional(),
  /** Older deployments omit it. */
  avatar: agentAvatarSchema.nullable().optional(),
  canAccess: z.boolean(),
})

/** An agent blocked from or by this one: they can't read or message each other. */
export const inboundXAgentBlockedAgentSchema = inboundXAgentCallerSchema.extend({
  /** What it may do here now, so lifting the block can take away what remains. */
  decision: z.enum(['allow', 'review', 'block']),
  /** The stored blocks, so lifting it clears exactly these. */
  blocks: z.array(z.object({ callerSlug: z.string(), operation: z.enum(['read', 'invoke']) })),
})

/**
 * An agent's access to another agent, in the words people's access uses:
 * a User messages it and reads its sessions, a Viewer only reads. `null`: it
 * asks a person first, or a block stands between them.
 */
export type AgentAccessRole = 'user' | 'viewer'
export function agentAccessRole(caller: Pick<InboundXAgentCaller, 'decision' | 'readDecision'>): AgentAccessRole | null {
  if (caller.readDecision === 'block') return null
  if (caller.decision === 'allow') return 'user'
  return caller.readDecision === 'allow' ? 'viewer' : null
}

const inboundSessionBaseSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
})

export const inboundXAgentSessionSchema = z.union([
  inboundSessionBaseSchema.extend({
    isWidgetRepair: z.literal(true),
    widgetRepairSlug: z.string().optional(),
  }),
  inboundSessionBaseSchema.extend({
    // Optional so existing x-agent history payloads remain valid.
    isWidgetRepair: z.literal(false).optional(),
    triggeredBy: z.object({
      slug: z.string(),
      name: z.string(),
    }),
  }),
])

export const inboundXAgentDetailsSchema = z.object({
  sessions: z.array(inboundXAgentSessionSchema),
  callers: z.array(inboundXAgentCallerSchema),
  /** Older deployments omit it. */
  blocked: z.array(inboundXAgentBlockedAgentSchema).optional(),
})

export type InboundXAgentCaller = z.infer<typeof inboundXAgentCallerSchema>
export type InboundXAgentBlockedAgent = z.infer<typeof inboundXAgentBlockedAgentSchema>
export type InboundXAgentSession = z.infer<typeof inboundXAgentSessionSchema>
export type InboundXAgentDetails = z.infer<typeof inboundXAgentDetailsSchema>

/** An agent that has a role on another agent: what a member stack and roster show for it. */
export const agentMemberAgentSchema = z.object({
  slug: z.string(),
  name: z.string(),
  avatar: agentAvatarSchema.nullable(),
  role: z.enum(['user', 'viewer']),
})
/** Every agent the viewer can see that has member agents, by slug. An agent with none is left out. */
export const agentMemberAgentsByAgentSchema = z.record(z.string(), z.array(agentMemberAgentSchema))
export type AgentMemberAgent = z.infer<typeof agentMemberAgentSchema>
export type AgentMemberAgentsByAgent = z.infer<typeof agentMemberAgentsByAgentSchema>
