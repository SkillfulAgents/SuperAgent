/**
 * Container-to-host proxy rule endpoints (create / list / delete).
 *
 * Auth: the calling agent's proxy token (Bearer). An agent can only touch rules
 * on accounts and MCP servers mapped to it.
 *
 * Creating a rule blocks on a person's confirmation: the draft (the agent's
 * own patterns, code and tests) is validated here, restated from its code by a
 * separate model call the agent cannot see or steer, and shown on a review
 * card. Deleting a rule blocks on a person's confirmation too. Listing does
 * not, but it shows the agent the code of only the rules it wrote.
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { validateProxyToken } from '@shared/lib/proxy/token-store'
import { agentRegistry } from '@shared/lib/agent-actor'
import { auditRuleChange, auditRuleDecision } from '@shared/lib/proxy/rules/audit-events'
import { createRule, addRuleVersion, deleteRule, getRule, listRules, toRuleView, type RuleTarget } from '@shared/lib/proxy/rules/store'
import { agentCanUseTarget, coverageLabels, loadTargetContext, prepareDraft } from '@shared/lib/proxy/rules/service'
import { MAX_RULES_PER_TARGET } from '@shared/lib/proxy/rules/engine'
import type { RuleProposalReview } from '@shared/lib/proxy/rules/proposal-schema'
import { RULE_HELPERS_DOC } from '@shared/lib/proxy/rules/helpers-source'
import { RULE_INPUT_DOC } from '@shared/lib/proxy/rules/input'

type Variables = { callerSlug: string }
const xAgentRules = new Hono<{ Variables: Variables }>()

xAgentRules.use('*', async (c, next) => {
  const token = c.req.header('Authorization')?.replace('Bearer ', '')
  const callerSlug = token ? await validateProxyToken(token) : null
  if (!callerSlug) return c.json({ error: 'Unauthorized' }, 401)
  c.set('callerSlug', callerSlug)
  await next()
})

const targetSchema = z.object({
  kind: z.enum(['api', 'mcp']),
  targetId: z.string().min(1),
})

const testCaseSchema = z.object({
  name: z.string().min(1).max(200),
  input: z.record(z.string(), z.unknown()),
  expect: z.boolean(),
})

const createSchema = targetSchema.extend({
  effect: z.enum(['allow', 'require']).default('allow'),
  description: z.string().min(1).max(2000),
  patterns: z.array(z.string()).min(1).max(50),
  code: z.string().min(1).max(20_000),
  tests: z.array(testCaseSchema).min(1).max(100),
  appliesTo: z.enum(['agent', 'all_agents']).default('agent'),
  replacesRuleId: z.string().optional(),
})

/** Reference docs the agent tool can surface (input shape, helpers). */
xAgentRules.post('/docs', (c) => c.json({ input: RULE_INPUT_DOC, helpers: RULE_HELPERS_DOC }))

xAgentRules.post('/list', zValidator('json', targetSchema), async (c) => {
  const callerSlug = c.get('callerSlug')
  const target: RuleTarget = c.req.valid('json')
  if (!await agentCanUseTarget(callerSlug, target)) {
    return c.json({ error: 'That account or MCP server is not available to this agent.' }, 404)
  }
  // The agent sees the code of the rules it wrote (so it can replace them);
  // of any other rule only what it is and what it does in a sentence.
  const rules = (await listRules(target, callerSlug)).map(toRuleView).map((rule) => (
    rule.createdBy === 'agent' && rule.createdByAgentSlug === callerSlug
      ? rule
      : {
        id: rule.id,
        effect: rule.effect,
        name: rule.name,
        version: rule.version,
        createdBy: rule.createdBy,
        appliesTo: rule.agentSlug === null ? 'all_agents' : 'agent',
      }
  ))
  return c.json({ rules })
})

xAgentRules.post('/delete', zValidator('json', z.object({ ruleId: z.string().min(1) })), async (c) => {
  const callerSlug = c.get('callerSlug')
  const existing = await getRule(c.req.valid('json').ruleId)
  const target = existing ? ruleTarget(existing.rule) : null
  if (!existing || !target || !await agentCanUseTarget(callerSlug, target)
    || (existing.rule.agentSlug !== null && existing.rule.agentSlug !== callerSlug)) {
    return c.json({ error: 'Rule not found.' }, 404)
  }
  const context = await loadTargetContext(target)
  if (!context) return c.json({ error: 'That account or MCP server no longer exists.' }, 404)

  // Deleting always asks the user: an allow rule's requests go back to
  // review, and a require rule's go through without it.
  const rule = toRuleView(existing)
  const consequence = rule.effect === 'require'
    ? 'Requests this rule holds for review will go through without review if your permissions allow them.'
    : 'Requests this rule lets through will go back to review.'
  const proposal: RuleProposalReview = {
    ruleKind: target.kind,
    targetId: target.targetId,
    targetName: context.name,
    appliesTo: rule.agentSlug === null ? 'all_agents' : 'agent',
    effect: rule.effect,
    description: rule.description,
    name: rule.name,
    restatement: rule.restatement,
    patterns: rule.patterns,
    code: rule.code,
    tests: [],
    coverage: [],
    warnings: [consequence],
    deletesRuleId: rule.id,
  }
  let decision: 'allow' | 'deny'
  try {
    decision = await agentRegistry.get(callerSlug).inputs.reviews.request({
      accountId: target.targetId,
      reviewType: target.kind,
      toolkit: context.toolkit ?? context.name,
      method: 'RULE',
      targetPath: `proxy-rules/${rule.id}`,
      matchedScopes: [],
      scopeDescriptions: {},
      endpointDescription: `Delete rule "${rule.name}" on ${context.name}?`,
      ruleProposal: proposal,
    }, c.req.raw.signal)
  } catch {
    await auditRuleDecision({ proposal, approved: false, agentSlug: callerSlug, via: 'timeout' })
    return c.json({ error: 'review_timeout', message: 'Deleting the rule needed approval but the request timed out. It was not deleted.' }, 408)
  }
  if (decision === 'deny') {
    return c.json({ error: 'denied_by_user', message: 'The user kept this rule.' }, 403)
  }
  // Delete only the version the user was shown.
  if (!await deleteRule(existing.rule.id, existing.version.id)) {
    return c.json({ error: 'rule_changed', message: 'The rule changed or was deleted while waiting for approval. It was not deleted.' }, 409)
  }
  await auditRuleChange('deleted', rule, { by: 'agent', agentSlug: callerSlug })
  return c.json({ ok: true, deleted: existing.rule.id })
})

xAgentRules.post('/create', zValidator('json', createSchema), async (c) => {
  const callerSlug = c.get('callerSlug')
  const body = c.req.valid('json')
  const target: RuleTarget = { kind: body.kind, targetId: body.targetId }
  if (!await agentCanUseTarget(callerSlug, target)) {
    return c.json({ error: 'That account or MCP server is not available to this agent.' }, 404)
  }
  const context = await loadTargetContext(target)
  if (!context) return c.json({ error: 'That account or MCP server no longer exists.' }, 404)
  if (!body.replacesRuleId && (await listRules(target)).length >= MAX_RULES_PER_TARGET) {
    return c.json({ error: 'too_many_rules', message: `This connection already has ${MAX_RULES_PER_TARGET} rules. Replace or delete one first.` }, 422)
  }

  let replaces = null
  if (body.replacesRuleId) {
    replaces = await getRule(body.replacesRuleId)
    const replacesTarget = replaces ? ruleTarget(replaces.rule) : null
    if (!replaces || replacesTarget?.kind !== target.kind || replacesTarget.targetId !== target.targetId
      || (replaces.rule.agentSlug !== null && replaces.rule.agentSlug !== callerSlug)) {
      return c.json({ error: 'The rule to replace was not found on this target.' }, 404)
    }
  }

  const prepared = await prepareDraft(context, {
    kind: body.kind,
    effect: body.effect,
    description: body.description,
    patterns: body.patterns,
    code: body.code,
    tests: body.tests,
  })
  if (!prepared.report.ok) {
    // Nothing reaches a person until the draft passes its own tests.
    return c.json({
      error: 'invalid_rule',
      message: 'The rule was not submitted for approval. Fix the errors and try again.',
      errors: prepared.report.errors,
      failedTests: prepared.report.testResults.filter((r) => !r.passed),
      warnings: prepared.report.warnings,
    }, 422)
  }

  const appliesTo = replaces ? (replaces.rule.agentSlug === null ? 'all_agents' : 'agent') : body.appliesTo
  const proposal: RuleProposalReview = {
    ruleKind: body.kind,
    targetId: body.targetId,
    targetName: context.name,
    appliesTo,
    effect: body.effect,
    description: body.description,
    name: prepared.name,
    restatement: prepared.restatement,
    patterns: body.patterns,
    code: body.code,
    tests: prepared.report.testResults.map((r) => ({
      name: r.name,
      expect: r.expect,
      passed: r.passed,
      result: r.outcome.result,
    })),
    coverage: coverageLabels(prepared.report),
    warnings: prepared.report.warnings,
    ...(replaces ? { replacesRuleId: replaces.rule.id } : {}),
  }

  let decision: 'allow' | 'deny'
  try {
    decision = await agentRegistry.get(callerSlug).inputs.reviews.request({
      accountId: body.targetId,
      reviewType: body.kind,
      toolkit: context.toolkit ?? context.name,
      method: 'RULE',
      targetPath: replaces ? `proxy-rules/${replaces.rule.id}` : 'proxy-rules',
      matchedScopes: [],
      scopeDescriptions: {},
      endpointDescription: replaces
        ? `Update rule "${prepared.name}" on ${context.name}?`
        : `Add rule "${prepared.name}" on ${context.name}?`,
      ruleProposal: proposal,
    }, c.req.raw.signal)
  } catch {
    await auditRuleDecision({ proposal, approved: false, agentSlug: callerSlug, via: 'timeout' })
    return c.json({ error: 'review_timeout', message: 'The rule needed approval but the request timed out. It was not saved.' }, 408)
  }
  if (decision === 'deny') {
    return c.json({ error: 'denied_by_user', message: 'The user rejected this rule. It was not saved.' }, 403)
  }

  const version = {
    effect: body.effect,
    name: prepared.name,
    description: body.description,
    restatement: prepared.restatement,
    patterns: body.patterns,
    code: body.code,
    tests: body.tests,
    warnings: prepared.report.warnings,
    toolSchemaHash: prepared.report.toolSchemaHash,
  }
  const saved = replaces
    ? await addRuleVersion(replaces.rule.id, version, replaces.version.id)
    : await createRule({
      target,
      agentSlug: appliesTo === 'agent' ? callerSlug : null,
      createdBy: 'agent',
      createdByAgentSlug: callerSlug,
      version,
      maxRules: MAX_RULES_PER_TARGET,
    })
  if (!saved) {
    return replaces
      ? c.json({ error: 'rule_changed', message: 'The rule changed or was deleted while awaiting approval. It was not saved.' }, 409)
      : c.json({ error: 'too_many_rules', message: `This connection reached ${MAX_RULES_PER_TARGET} rules while awaiting approval. It was not saved.` }, 409)
  }
  const view = toRuleView(saved)
  await auditRuleChange(replaces ? 'updated' : 'created', view, { by: 'agent', agentSlug: callerSlug })
  return c.json({ ok: true, rule: view })
})

function ruleTarget(rule: { kind: 'api' | 'mcp'; accountId: string | null; mcpId: string | null }): RuleTarget | null {
  const targetId = rule.kind === 'api' ? rule.accountId : rule.mcpId
  return targetId ? { kind: rule.kind, targetId } : null
}

export default xAgentRules
