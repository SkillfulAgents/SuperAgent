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
  /** Whether it can message here: one of its owners is a User here, and messaging isn't blocked. Older deployments omit it. */
  canMessage: z.boolean().optional(),
  /** Older deployments omit it. */
  avatar: agentAvatarSchema.nullable().optional(),
  canAccess: z.boolean(),
})

/** An agent with a block saved between it and this one, in either direction. */
export const inboundXAgentBlockedAgentSchema = inboundXAgentCallerSchema.extend({
  /** What it may do here now, so lifting the block can take away what remains. */
  decision: z.enum(['allow', 'review', 'block']),
  /** The stored blocks, so lifting it clears exactly these. */
  blocks: z.array(z.object({ callerSlug: z.string(), operation: z.enum(['read', 'invoke']) })),
})

/**
 * An agent's access to another agent, in the words people's access uses:
 * a User messages it and reads its sessions, a Viewer only reads. `null`: it
 * asks a person first for both.
 */
export type AgentAccessRole = 'user' | 'viewer'
/** A pick in an agent's role menu: a role, Remove (asks first for both), or Block (both, both ways). */
export const agentAccessChangeSchema = z.enum(['user', 'viewer', 'remove', 'block'])
export type AgentAccessChange = z.infer<typeof agentAccessChangeSchema>
export function agentAccessRole(caller: Pick<InboundXAgentCaller, 'decision' | 'readDecision' | 'canMessage'>): AgentAccessRole | null {
  if (caller.decision === 'allow' && caller.canMessage !== false) return 'user'
  return caller.readDecision === 'allow' ? 'viewer' : null
}

/**
 * The line under an agent's name where its role alone would mislead: a User whose reading still asks first
 * or is blocked, or a block that covers less than reading and messaging in both directions (four saved blocks).
 */
export function agentAccessNote(agent: { role: AgentAccessRole | 'blocked'; readDecision?: InboundXAgentCaller['readDecision']; blocks?: InboundXAgentBlockedAgent['blocks'] }): string | null {
  if (agent.role === 'blocked') return (agent.blocks?.length ?? 0) < 4 ? 'Partly blocked' : 'Can’t read or message each other'
  if (agent.role !== 'user') return null
  return agent.readDecision === 'review' ? 'Reading asks first' : agent.readDecision === 'block' ? 'Reading blocked' : null
}

/** The agents with a role here. A block in either direction keeps an agent out, as it does the share popover's lists. */
export function memberAgentsOf({ callers, blocked = [] }: Pick<InboundXAgentDetails, 'callers' | 'blocked'>): (InboundXAgentCaller & { role: AgentAccessRole })[] {
  const blockedSlugs = new Set(blocked.map((agent) => agent.slug))
  return callers.flatMap((agent) => {
    const role = agentAccessRole(agent)
    return role && !blockedSlugs.has(agent.slug) ? [{ ...agent, role }] : []
  })
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
  /** Older deployments omit it. */
  readDecision: z.enum(['allow', 'review', 'block']).optional(),
})
/** Every agent the viewer can see that has member agents, by slug. An agent with none is left out. */
export const agentMemberAgentsByAgentSchema = z.record(z.string(), z.array(agentMemberAgentSchema))
export type AgentMemberAgent = z.infer<typeof agentMemberAgentSchema>
export type AgentMemberAgentsByAgent = z.infer<typeof agentMemberAgentsByAgentSchema>
