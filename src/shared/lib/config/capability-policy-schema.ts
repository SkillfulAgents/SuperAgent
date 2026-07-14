import { z } from 'zod'

/**
 * Three-tier launch policy for the agent's delegation capabilities:
 * - allow: launches run without asking
 * - review: each launch pauses on an approval card until the user decides
 * - block: the capability is removed from the session (tools + prompt)
 */
export const capabilityPolicySchema = z.enum(['allow', 'review', 'block'])
export type CapabilityPolicy = z.infer<typeof capabilityPolicySchema>

export const agentCapabilitySettingsSchema = z.object({
  subagents: capabilityPolicySchema,
  workflows: capabilityPolicySchema,
})
export type AgentCapabilitySettings = z.infer<typeof agentCapabilitySettingsSchema>

/** Partial patch shape accepted by PUT /settings. */
export const agentCapabilitySettingsPatchSchema = agentCapabilitySettingsSchema.partial()

// Subagents default open (they are core to browsing/dashboards and cheap-tier
// delegation); workflows default to review (a single launch can fan out into
// dozens of agents).
export const DEFAULT_AGENT_CAPABILITIES: AgentCapabilitySettings = {
  subagents: 'allow',
  workflows: 'review',
}
