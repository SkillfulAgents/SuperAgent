/**
 * Persistence for proxy rules. Versions are immutable: an edit appends a
 * version and repoints the rule; a delete is soft so audit rows that name a
 * version keep resolving.
 */
import { randomUUID } from 'node:crypto'
import { and, asc, eq, inArray, isNull, or } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { batch } from '@shared/lib/db/batch'
import { proxyRules, proxyRuleVersions, type ProxyRule, type ProxyRuleVersion } from '@shared/lib/db/schema'
import type { ActiveRule, RuleEffect, RuleKind, RuleTestCase } from './engine'

export interface RuleTarget {
  kind: RuleKind
  /** Connected account id (api) or remote MCP server id (mcp). */
  targetId: string
}

export interface SavedRuleVersionInput {
  effect: RuleEffect
  name: string
  description: string
  restatement: string
  patterns: string[]
  code: string
  tests: RuleTestCase[]
  warnings: string[]
  toolSchemaHash: string | null
}

export interface RuleWithVersion {
  rule: ProxyRule
  version: ProxyRuleVersion
}

export interface RuleView {
  id: string
  kind: RuleKind
  targetId: string
  agentSlug: string | null
  createdBy: 'user' | 'agent'
  createdByAgentSlug: string | null
  createdAt: string
  updatedAt: string
  versionId: string
  version: number
  effect: RuleEffect
  name: string
  description: string
  restatement: string
  patterns: string[]
  code: string
  tests: RuleTestCase[]
  warnings: string[]
}

// Live rules per target, for the proxies' hot path. Every write here drops
// the target's entry; the TTL bounds staleness from writes this process
// didn't make (another process on the same database, cascade deletes).
const CACHE_TTL_MS = 5_000
const activeRuleCache = new Map<string, { loadedAt: number; rules: Array<{ agentSlug: string | null; active: ActiveRule }> }>()
let cacheGeneration = 0

function cacheKey(target: RuleTarget): string {
  return `${target.kind}:${target.targetId}`
}

/** Forget cached rules: one target's, or every target's. */
export function invalidateRuleCache(target?: RuleTarget): void {
  cacheGeneration++
  if (target) activeRuleCache.delete(cacheKey(target))
  else activeRuleCache.clear()
}

/** Live rules that apply to `agentSlug` on a target, cached briefly. */
export async function listActiveRules(target: RuleTarget, agentSlug: string): Promise<ActiveRule[]> {
  const key = cacheKey(target)
  let cached = activeRuleCache.get(key)
  if (!cached || Date.now() - cached.loadedAt > CACHE_TTL_MS) {
    const generation = cacheGeneration
    const rows = await listRules(target)
    cached = { loadedAt: Date.now(), rules: rows.map((row) => ({ agentSlug: row.rule.agentSlug, active: toActiveRule(row) })) }
    // A write that landed while this read was in flight wins.
    if (generation === cacheGeneration) activeRuleCache.set(key, cached)
  }
  return cached.rules.filter((r) => r.agentSlug === null || r.agentSlug === agentSlug).map((r) => r.active)
}

function targetCondition(target: RuleTarget) {
  return target.kind === 'api'
    ? and(eq(proxyRules.kind, 'api'), eq(proxyRules.accountId, target.targetId))
    : and(eq(proxyRules.kind, 'mcp'), eq(proxyRules.mcpId, target.targetId))
}

function parseJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

export function toRuleView({ rule, version }: RuleWithVersion): RuleView {
  return {
    id: rule.id,
    kind: rule.kind,
    targetId: (rule.kind === 'api' ? rule.accountId : rule.mcpId) ?? '',
    agentSlug: rule.agentSlug,
    createdBy: rule.createdBy,
    createdByAgentSlug: rule.createdByAgentSlug,
    createdAt: rule.createdAt.toISOString(),
    updatedAt: rule.updatedAt.toISOString(),
    versionId: version.id,
    version: version.version,
    effect: version.effect,
    name: version.name,
    description: version.description,
    restatement: version.restatement,
    patterns: parseJson<string[]>(version.patterns, []),
    code: version.code,
    tests: parseJson<RuleTestCase[]>(version.tests, []),
    warnings: parseJson<string[]>(version.warnings, []),
  }
}

/**
 * Live rules for a target, oldest first. With `agentSlug`, only rules that
 * apply to that agent (account-wide or scoped to it); without, every rule.
 */
export async function listRules(target: RuleTarget, agentSlug?: string): Promise<RuleWithVersion[]> {
  const agentCondition = agentSlug === undefined
    ? undefined
    : or(isNull(proxyRules.agentSlug), eq(proxyRules.agentSlug, agentSlug))
  return db
    .select({ rule: proxyRules, version: proxyRuleVersions })
    .from(proxyRules)
    .innerJoin(proxyRuleVersions, eq(proxyRuleVersions.id, proxyRules.currentVersionId))
    .where(and(targetCondition(target), isNull(proxyRules.deletedAt), agentCondition))
    .orderBy(asc(proxyRules.createdAt), asc(proxyRules.id))
    .all()
}

export function toActiveRule({ rule, version }: RuleWithVersion): ActiveRule {
  return {
    ruleId: rule.id,
    versionId: version.id,
    version: version.version,
    kind: rule.kind,
    effect: version.effect,
    name: version.name,
    restatement: version.restatement,
    patterns: parseJson<string[]>(version.patterns, []),
    code: version.code,
    toolSchemaHash: version.toolSchemaHash,
  }
}

export async function getRule(ruleId: string): Promise<RuleWithVersion | null> {
  const [row] = await db
    .select({ rule: proxyRules, version: proxyRuleVersions })
    .from(proxyRules)
    .innerJoin(proxyRuleVersions, eq(proxyRuleVersions.id, proxyRules.currentVersionId))
    .where(and(eq(proxyRules.id, ruleId), isNull(proxyRules.deletedAt)))
    .limit(1)
  return row ?? null
}

export async function getRuleVersions(versionIds: string[]): Promise<ProxyRuleVersion[]> {
  if (versionIds.length === 0) return []
  return db.select().from(proxyRuleVersions).where(inArray(proxyRuleVersions.id, versionIds)).all()
}

function versionValues(ruleId: string, version: number, input: SavedRuleVersionInput, now: Date) {
  return {
    id: randomUUID(),
    ruleId,
    version,
    effect: input.effect,
    name: input.name,
    description: input.description,
    restatement: input.restatement,
    patterns: JSON.stringify(input.patterns),
    code: input.code,
    tests: JSON.stringify(input.tests),
    warnings: JSON.stringify(input.warnings),
    toolSchemaHash: input.toolSchemaHash,
    createdAt: now,
  }
}

export async function createRule(options: {
  target: RuleTarget
  agentSlug: string | null
  createdBy: 'user' | 'agent'
  createdByAgentSlug: string | null
  version: SavedRuleVersionInput
}): Promise<RuleWithVersion> {
  const now = new Date()
  const ruleId = randomUUID()
  const version = versionValues(ruleId, 1, options.version, now)
  await batch([
    db.insert(proxyRules).values({
      id: ruleId,
      kind: options.target.kind,
      accountId: options.target.kind === 'api' ? options.target.targetId : null,
      mcpId: options.target.kind === 'mcp' ? options.target.targetId : null,
      agentSlug: options.agentSlug,
      createdBy: options.createdBy,
      createdByAgentSlug: options.createdByAgentSlug,
      currentVersionId: version.id,
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(proxyRuleVersions).values(version),
  ])
  invalidateRuleCache(options.target)
  const saved = await getRule(ruleId)
  if (!saved) throw new Error('Rule disappeared after insert')
  return saved
}

/** Append a version and make it current. Returns null if the rule is gone. */
export async function addRuleVersion(ruleId: string, input: SavedRuleVersionInput): Promise<RuleWithVersion | null> {
  const current = await getRule(ruleId)
  if (!current) return null
  const now = new Date()
  const version = versionValues(ruleId, current.version.version + 1, input, now)
  await batch([
    db.insert(proxyRuleVersions).values(version),
    db.update(proxyRules)
      .set({ currentVersionId: version.id, updatedAt: now })
      .where(and(eq(proxyRules.id, ruleId), eq(proxyRules.currentVersionId, current.version.id))),
  ])
  invalidateRuleCache()
  return getRule(ruleId)
}

export async function deleteRule(ruleId: string): Promise<boolean> {
  const result = await db.update(proxyRules)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(proxyRules.id, ruleId), isNull(proxyRules.deletedAt)))
    .returning({ id: proxyRules.id })
    .all()
  invalidateRuleCache()
  return result.length > 0
}
