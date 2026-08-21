import { z } from 'zod'

/**
 * Shape of the JSON emitted by the PowerShell detection script in
 * `windows-firewall/index.ts`. Parsed with Zod at the boundary because the
 * output crosses a process boundary and PowerShell's ConvertTo-Json has
 * version-dependent quirks (single-element pipelines can serialize as a bare
 * object instead of a one-element array).
 */

const blockRuleSchema = z.object({
  name: z.string(),
  displayName: z.string(),
  profile: z.string(),
})

export type FirewallBlockRule = z.infer<typeof blockRuleSchema>

/** Accept object-or-array-or-null and normalize to an array. */
const ruleListSchema = z
  .union([z.array(blockRuleSchema), blockRuleSchema, z.null()])
  .transform((v): FirewallBlockRule[] => (v == null ? [] : Array.isArray(v) ? v : [v]))

export const firewallProbeOutputSchema = z.object({
  blockRules: ruleListSchema,
  hyperVInboundBlock: z.boolean(),
})

export type FirewallProbeOutput = z.infer<typeof firewallProbeOutputSchema>
