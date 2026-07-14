import { z } from 'zod'
import type { AgentCapabilityPolicies, CapabilityPolicy } from './types'

export type Capability = 'subagents' | 'workflows'

// The SDK exposes subagent spawning as `Task` (legacy) and `Agent` (its rename);
// both names gate as the same capability.
export const SUBAGENT_TOOL_NAMES: ReadonlySet<string> = new Set(['Task', 'Agent'])
export const WORKFLOW_TOOL_NAME = 'Workflow'

// Boundary schema for policies arriving over HTTP (create-session / send-message
// bodies). `.parse()` at the seam so a malformed value fails loudly instead of
// silently degrading a block to allow.
export const capabilityPolicySchema = z.enum(['allow', 'review', 'block'])
export const agentCapabilityPoliciesSchema = z
  .object({
    subagents: capabilityPolicySchema.optional(),
    workflows: capabilityPolicySchema.optional(),
  })
  .optional()

// Boundary schema for the resolve payload of a capability review (host answers
// via POST /inputs/:toolUseId/resolve). Unknown shapes count as a plain
// one-time approval — the approval itself was explicit, only the scope is soft.
const reviewDecisionSchema = z.object({ scope: z.enum(['once', 'session']).catch('once') })

export function parseReviewDecisionScope(value: unknown): 'once' | 'session' {
  const parsed = reviewDecisionSchema.safeParse(value)
  return parsed.success ? parsed.data.scope : 'once'
}

export function capabilityForTool(toolName: string): Capability | null {
  if (SUBAGENT_TOOL_NAMES.has(toolName)) return 'subagents'
  if (toolName === WORKFLOW_TOOL_NAME) return 'workflows'
  return null
}

export function policyFor(
  policies: AgentCapabilityPolicies | undefined,
  capability: Capability,
): CapabilityPolicy {
  return policies?.[capability] ?? 'allow'
}

/**
 * Applies block policies to the query's tool lists. Blocked capabilities are
 * removed from allowedTools AND added to disallowedTools so the model never
 * sees the tool; blocked workflows additionally turn off the enableWorkflows
 * settings flag that surfaces the Workflow tool in headless mode.
 */
export function applyCapabilityPolicies(
  policies: AgentCapabilityPolicies | undefined,
  base: { allowedTools: string[]; disallowedTools: string[] },
): { allowedTools: string[]; disallowedTools: string[]; enableWorkflows: boolean } {
  const subagents = policyFor(policies, 'subagents')
  const workflows = policyFor(policies, 'workflows')
  const allowedTools =
    subagents === 'block'
      ? base.allowedTools.filter(t => !SUBAGENT_TOOL_NAMES.has(t))
      : [...base.allowedTools]
  const disallowedTools = [...base.disallowedTools]
  if (subagents === 'block') disallowedTools.push(...SUBAGENT_TOOL_NAMES)
  if (workflows === 'block') disallowedTools.push(WORKFLOW_TOOL_NAME)
  return { allowedTools, disallowedTools, enableWorkflows: workflows !== 'block' }
}

/**
 * Decides whether a tool call must be gated. Returns null when the call may
 * proceed (not a capability launch, policy is allow, or a session-scoped
 * grant covers it). A grant never overrides block.
 */
export function capabilityGateFor(
  toolName: string,
  policies: AgentCapabilityPolicies | undefined,
  sessionGrants: ReadonlySet<Capability>,
): { capability: Capability; policy: 'review' | 'block' } | null {
  const capability = capabilityForTool(toolName)
  if (!capability) return null
  const policy = policyFor(policies, capability)
  if (policy === 'allow') return null
  if (policy === 'review' && sessionGrants.has(capability)) return null
  return { capability, policy }
}

/**
 * True when a policy update flips the block boundary for either capability.
 * Block is baked into the query options (tool lists + system prompt), so
 * crossing it requires an interrupt+restart; allow<->review does not.
 */
export function blockBoundaryChanged(
  current: AgentCapabilityPolicies | undefined,
  next: AgentCapabilityPolicies | undefined,
): boolean {
  const capabilities: Capability[] = ['subagents', 'workflows']
  return capabilities.some(
    c => (policyFor(current, c) === 'block') !== (policyFor(next, c) === 'block'),
  )
}

const CAPABILITY_LABELS: Record<Capability, string> = {
  subagents: 'subagent',
  workflows: 'workflow',
}

export function blockedCapabilityMessage(capability: Capability): string {
  return `Launching ${CAPABILITY_LABELS[capability]}s is disabled in this app's settings. Do the work directly in this session instead of delegating it.`
}

export function reviewDeclinedMessage(capability: Capability, reason?: string): string {
  const base = `The user declined this ${CAPABILITY_LABELS[capability]} launch.`
  const suffix = ' Continue the task without it — do the work directly in this session, or ask the user how they would like to proceed.'
  return reason && reason !== 'User declined' ? `${base} Reason: ${reason}.${suffix}` : `${base}${suffix}`
}
