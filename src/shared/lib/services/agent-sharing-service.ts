import { randomUUID } from 'node:crypto'
import { and, eq, inArray, isNull, notExists, or } from 'drizzle-orm'
import { agentCatalog } from '@shared/lib/agent-actor'
import { db } from '@shared/lib/db'
import { batch, insertWhere } from '@shared/lib/db/batch'
import { agentAcl, xAgentPolicies as policies } from '@shared/lib/db/schema'
import { hasMinRole } from '@shared/lib/types/agent'
import type { AgentShareRoster, MemberAgentRole } from '@shared/lib/types/agent-sharing'

/** The stack needs only explicit grants. An open roster also checks global grants for its one target. */
export async function listAgentShares(targets: string[], viewerId: string | null, includeGlobal = false) {
  const rosters: Record<string, AgentShareRoster> = Object.create(null)
  if (!targets.length) return rosters
  const rows = await db.select({
    caller: policies.callerAgentSlug, target: policies.targetAgentSlug, operation: policies.operation, decision: policies.decision,
  }).from(policies).where(and(
    inArray(policies.operation, ['read', 'invoke']),
    or(inArray(policies.targetAgentSlug, targets), isNull(policies.targetAgentSlug)),
    viewerId === null ? undefined : inArray(policies.callerAgentSlug,
      db.select({ slug: agentAcl.agentSlug }).from(agentAcl).where(eq(agentAcl.userId, viewerId))),
  ))
  const grants = rows.filter(row => row.decision === 'allow' && (includeGlobal || row.target !== null))
  if (!grants.length) return rosters
  const callers = [...new Set(grants.map(row => row.caller))]
  const [agents, acl] = await Promise.all([
    agentCatalog.getMany(callers),
    viewerId === null ? [] : db.select({ slug: agentAcl.agentSlug, userId: agentAcl.userId, role: agentAcl.role })
      .from(agentAcl).where(inArray(agentAcl.agentSlug, [...new Set([...targets, ...callers])])),
  ])
  const roles = new Map([...Map.groupBy(acl, row => row.slug)].map(([slug, entries]) =>
    [slug, new Map(entries.map(entry => [entry.userId, entry.role]))]))
  const byCaller = Map.groupBy(rows, row => row.caller)
  for (const { slug, name, avatar } of agents.sort((a, b) => a.name.localeCompare(b.name))) {
    const byTarget = Map.groupBy(byCaller.get(slug)!, row => row.target)
    const defaults = byTarget.get(null) ?? []
    const owners = [...(roles.get(slug) ?? [])].filter(([, role]) => role === 'owner')
    for (const target of includeGlobal ? targets : byTarget.keys()) {
      if (!target || target === slug) continue
      const direct = byTarget.get(target) ?? []
      const ownerRoles = owners.map(([id]) => roles.get(target)?.get(id) ?? null)
      const canMessage = viewerId === null || ownerRoles.some(role => hasMinRole(role, 'user'))
      if (viewerId !== null && !ownerRoles.some(role => hasMinRole(role, 'viewer'))) continue
      const effective = (operation: 'invoke' | 'read') =>
        direct.find(row => row.operation === operation) ?? defaults.find(row => row.operation === operation)
      const invoke = canMessage ? effective('invoke') : undefined
      const read = effective('read')
      const canInvoke = invoke?.decision === 'allow'
      const canRead = read?.decision === 'allow'
      if (!canInvoke && !canRead) continue
      const isDirect = (canInvoke && invoke.target === target) || (canRead && read.target === target)
      if (!isDirect && !includeGlobal) continue
      const roster = rosters[target] ??= { direct: [], global: [] }
      roster[isDirect ? 'direct' : 'global'].push({ slug, name, avatar, canMessage, role: canInvoke ? 'user' : 'viewer' })
    }
  }
  return rosters
}

/** Removing a direct grant lets that operation inherit its global setting. Other restrictions survive. */
export async function changeAgentShare(caller: string, target: string, role: MemberAgentRole | 'remove') {
  const pair = and(eq(policies.callerAgentSlug, caller), eq(policies.targetAgentSlug, target))
  const allowed = and(pair, eq(policies.decision, 'allow'))
  if (role === 'remove') {
    await db.delete(policies).where(and(allowed, inArray(policies.operation, ['read', 'invoke']))).run()
    return
  }
  const now = new Date()
  const row = (operation: 'read' | 'invoke', decision: 'allow' | 'review') => ({
    id: randomUUID(), callerAgentSlug: caller, targetAgentSlug: target, operation, decision, createdAt: now, updatedAt: now,
  })
  const allow = (operation: 'read' | 'invoke') => db.insert(policies).values(row(operation, 'allow')).onConflictDoUpdate({
    target: [policies.callerAgentSlug, policies.targetAgentSlug, policies.operation], set: { decision: 'allow', updatedAt: now },
  })
  if (role === 'user') {
    await batch([allow('read'), allow('invoke')])
  } else {
    // Keep Viewer explicit when global settings change, while honoring an existing messaging restriction.
    const globalBlock = db.select({ id: policies.id }).from(policies).where(and(
      eq(policies.callerAgentSlug, caller), isNull(policies.targetAgentSlug), eq(policies.operation, 'invoke'), eq(policies.decision, 'block'),
    ))
    await batch([allow('read'), db.delete(policies).where(and(allowed, eq(policies.operation, 'invoke'))),
      insertWhere(policies, row('invoke', 'review'), notExists(globalBlock)).onConflictDoNothing()])
  }
}
