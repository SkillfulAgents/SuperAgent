import { db } from '@shared/lib/db'
import { apiScopePolicies, mcpToolPolicies } from '@shared/lib/db/schema'
import { eq } from 'drizzle-orm'
import { getUserSettings } from '@shared/lib/services/user-settings-service'
import type { ScopeMatchResult } from './scope-matcher'

export type PolicyDecision = 'allow' | 'review' | 'block'

export interface PolicyResult {
  decision: PolicyDecision
  matchedScopes: string[]
  scopeDescriptions: Record<string, string>
  resolvedFrom: 'scope_policy' | 'account_default' | 'global_default'
}

// Higher = more permissive
const DECISION_PRIORITY: Record<PolicyDecision, number> = {
  allow: 3,
  review: 2,
  block: 1,
}

function mostPermissive(a: PolicyDecision, b: PolicyDecision): PolicyDecision {
  return DECISION_PRIORITY[a] >= DECISION_PRIORITY[b] ? a : b
}

/**
 * Resolve the policy decision for an API proxy request.
 *
 * Resolution:
 * 1. For each matched scope, look up explicit policy → account default → global default
 * 2. Return the most permissive decision across all matched scopes
 */
export async function resolveApiPolicy(
  accountId: string,
  matchResult: ScopeMatchResult,
  userId: string
): Promise<PolicyResult> {
  // Fetch all policies for this account
  const rows = db
    .select({ policy: apiScopePolicies })
    .from(apiScopePolicies)
    .where(eq(apiScopePolicies.accountId, accountId))
    .all()

  const policyMap = new Map<string, PolicyDecision>()
  for (const row of rows) {
    policyMap.set(row.policy.scope, row.policy.decision as PolicyDecision)
  }

  const globalDefault = getUserSettings(userId).defaultApiPolicy as PolicyDecision
  const accountDefault = policyMap.get('*')

  // If no scopes matched, fall to account default → global default
  if (!matchResult.matched || matchResult.scopes.length === 0) {
    if (accountDefault) {
      return {
        decision: accountDefault,
        matchedScopes: [],
        scopeDescriptions: {},
        resolvedFrom: 'account_default',
      }
    }
    return {
      decision: globalDefault,
      matchedScopes: [],
      scopeDescriptions: {},
      resolvedFrom: 'global_default',
    }
  }

  // Resolve per-scope, then take most permissive
  let bestDecision: PolicyDecision | null = null
  let resolvedFrom: PolicyResult['resolvedFrom'] = 'global_default'

  for (const scope of matchResult.scopes) {
    const explicit = policyMap.get(scope)
    let scopeDecision: PolicyDecision
    let scopeFrom: PolicyResult['resolvedFrom']

    if (explicit) {
      scopeDecision = explicit
      scopeFrom = 'scope_policy'
    } else if (accountDefault) {
      scopeDecision = accountDefault
      scopeFrom = 'account_default'
    } else {
      scopeDecision = globalDefault
      scopeFrom = 'global_default'
    }

    if (bestDecision === null) {
      bestDecision = scopeDecision
      resolvedFrom = scopeFrom
    } else {
      const prev: PolicyDecision = bestDecision
      bestDecision = mostPermissive(bestDecision, scopeDecision)
      // Track the source of the winning decision
      if (bestDecision !== prev) {
        resolvedFrom = scopeFrom
      }
    }
  }

  return {
    decision: bestDecision ?? globalDefault,
    matchedScopes: matchResult.scopes,
    scopeDescriptions: matchResult.descriptions,
    resolvedFrom,
  }
}

/**
 * Resolve the policy decision for an MCP proxy request.
 *
 * Resolution:
 * 1. Explicit tool policy → MCP default (tool_name='*') → global default
 */
export async function resolveMcpPolicy(
  mcpId: string,
  toolName: string | null,
  userId: string
): Promise<PolicyResult> {
  const rows = db
    .select({ policy: mcpToolPolicies })
    .from(mcpToolPolicies)
    .where(eq(mcpToolPolicies.mcpId, mcpId))
    .all()

  const policyMap = new Map<string, PolicyDecision>()
  for (const row of rows) {
    policyMap.set(row.policy.toolName, row.policy.decision as PolicyDecision)
  }

  const settings = getUserSettings(userId)
  const globalDefault = (settings.defaultMcpPolicy ?? settings.defaultApiPolicy) as PolicyDecision
  const mcpDefault = policyMap.get('*')

  // If toolName provided, check explicit → MCP default → global
  if (toolName) {
    const explicit = policyMap.get(toolName)
    if (explicit) {
      return {
        decision: explicit,
        matchedScopes: [toolName],
        scopeDescriptions: {},
        resolvedFrom: 'scope_policy',
      }
    }
  }

  // Fall to MCP default → global
  if (mcpDefault) {
    return {
      decision: mcpDefault,
      matchedScopes: toolName ? [toolName] : [],
      scopeDescriptions: {},
      resolvedFrom: 'account_default',
    }
  }

  return {
    decision: globalDefault,
    matchedScopes: toolName ? [toolName] : [],
    scopeDescriptions: {},
    resolvedFrom: 'global_default',
  }
}
