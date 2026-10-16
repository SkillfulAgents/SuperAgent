/**
 * User-facing proxy rule endpoints, per connected account (/api/:accountId)
 * or remote MCP server (/mcp/:mcpId):
 *   GET    /:kind/:id            list live rules
 *   POST   /:kind/:id/author     plain English → draft or clarifying question
 *   POST   /:kind/:id            save a draft (re-validated here)
 *   DELETE /:kind/:id/:ruleId    soft-delete a rule
 */
import { Hono, type MiddlewareHandler } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { Authenticated, OwnsAccountByParam, OwnsMcpByParam } from '../middleware/auth'
import { getCurrentUserId } from '@shared/lib/auth/config'
import { auditRuleChange } from '@shared/lib/proxy/rules/audit-events'
import { authorRule } from '@shared/lib/proxy/rules/author'
import { catalogPolicies, coverageLabels, fallbackRuleName, loadTargetContext, prepareDraft } from '@shared/lib/proxy/rules/service'
import { createRule, deleteRule, getRule, listRules, toRuleView, type RuleTarget } from '@shared/lib/proxy/rules/store'
import { MAX_RULES_PER_TARGET, type RuleKind } from '@shared/lib/proxy/rules/engine'

const proxyRules = new Hono()
proxyRules.use('*', Authenticated())

const testCaseSchema = z.object({
  name: z.string().min(1).max(200),
  input: z.record(z.string(), z.unknown()),
  expect: z.boolean(),
})

const draftSchema = z.object({
  effect: z.enum(['allow', 'require']).default('allow'),
  description: z.string().min(1).max(2000),
  patterns: z.array(z.string()).min(1).max(50),
  code: z.string().min(1).max(20_000),
  tests: z.array(testCaseSchema).min(1).max(100),
})

const authorSchema = z.object({
  description: z.string().min(1).max(2000),
  clarifications: z.array(z.object({ question: z.string(), answer: z.string() })).max(10).optional(),
})

const saveSchema = z.object({
  draft: draftSchema,
  /** The name shown in the composer, possibly edited by the person saving. */
  name: z.string().trim().min(1).max(80).optional(),
  /** Optional: limit the rule to one agent's requests. */
  agentSlug: z.string().min(1).optional(),
})

function mount(kind: RuleKind, param: 'accountId' | 'mcpId', owns: (param: string) => MiddlewareHandler) {
  const base = `/${kind}/:${param}`
  const target = (c: { req: { param: (name: string) => string | undefined } }): RuleTarget =>
    ({ kind, targetId: c.req.param(param) ?? '' })

  proxyRules.get(base, owns(param), async (c) => {
    const rules = (await listRules(target(c))).map(toRuleView)
    return c.json({ rules })
  })

  proxyRules.post(`${base}/author`, owns(param), zValidator('json', authorSchema), async (c) => {
    const context = await loadTargetContext(target(c))
    if (!context) return c.json({ error: 'Not found' }, 404)
    const body = c.req.valid('json')
    const existingRules = (await listRules(target(c))).map(toRuleView)
    try {
      const result = await authorRule({
        kind,
        description: body.description,
        toolkit: context.toolkit,
        targetName: context.name,
        tools: context.tools,
        policies: await catalogPolicies(context),
        existingRules: existingRules.map((r) => ({ effect: r.effect, name: r.name, restatement: r.restatement, patterns: r.patterns })),
        clarifications: body.clarifications,
      })
      if (result.type === 'question') return c.json(result)
      const prepared = result.report.ok
        ? await prepareDraft(context, result.draft)
        : { draft: result.draft, report: result.report, name: fallbackRuleName(result.draft.description), restatement: '' }
      return c.json({
        type: 'draft',
        draft: prepared.draft,
        name: prepared.name,
        restatement: prepared.restatement,
        report: prepared.report,
        coverage: coverageLabels(prepared.report),
        attempts: result.attempts,
      })
    } catch (error) {
      console.error('[proxy-rules] Authoring failed:', error)
      return c.json({ error: error instanceof Error ? error.message : 'Rule authoring failed' }, 502)
    }
  })

  proxyRules.post(base, owns(param), zValidator('json', saveSchema), async (c) => {
    const context = await loadTargetContext(target(c))
    if (!context) return c.json({ error: 'Not found' }, 404)
    const body = c.req.valid('json')
    if ((await listRules(target(c))).length >= MAX_RULES_PER_TARGET) {
      return c.json({ error: `This connection already has ${MAX_RULES_PER_TARGET} rules. Delete one first.` }, 422)
    }
    const prepared = await prepareDraft(context, { kind, ...body.draft })
    if (!prepared.report.ok) {
      return c.json({ error: 'invalid_rule', errors: prepared.report.errors, report: prepared.report }, 422)
    }
    const saved = await createRule({
      target: target(c),
      agentSlug: body.agentSlug ?? null,
      createdBy: 'user',
      createdByAgentSlug: null,
      version: {
        ...body.draft,
        name: body.name ?? prepared.name,
        restatement: prepared.restatement,
        warnings: prepared.report.warnings,
        toolSchemaHash: prepared.report.toolSchemaHash,
      },
      maxRules: MAX_RULES_PER_TARGET,
    })
    if (!saved) return c.json({ error: `This connection already has ${MAX_RULES_PER_TARGET} rules. Delete one first.` }, 422)
    const view = toRuleView(saved)
    await auditRuleChange('created', view, { by: 'user' }, getCurrentUserId(c))
    return c.json({ rule: view })
  })

  proxyRules.delete(`${base}/:ruleId`, owns(param), async (c) => {
    const existing = await getRule(c.req.param('ruleId'))
    const existingTarget = existing?.rule.kind === 'api' ? existing.rule.accountId : existing?.rule.mcpId
    if (!existing || existing.rule.kind !== kind || existingTarget !== c.req.param(param)) {
      return c.json({ error: 'Rule not found' }, 404)
    }
    if (await deleteRule(existing.rule.id)) {
      await auditRuleChange('deleted', toRuleView(existing), { by: 'user' }, getCurrentUserId(c))
    }
    return c.json({ ok: true })
  })
}

mount('api', 'accountId', OwnsAccountByParam)
mount('mcp', 'mcpId', OwnsMcpByParam)

export default proxyRules
