/**
 * User-facing proxy rule endpoints, per connected account (/api/:accountId)
 * or remote MCP server (/mcp/:mcpId):
 *   GET    /:kind/:id            list live rules
 *   POST   /:kind/:id/author         start writing a rule from plain English → job id
 *   GET    /:kind/:id/author/:jobId  wait (briefly) for it: a draft or a clarifying question
 *   POST   /:kind/:id                save a draft the author job produced
 *   DELETE /:kind/:id/:ruleId        soft-delete a rule
 *
 * Writing a rule takes several model calls, often over a minute; proxies in
 * front of a cloud deployment cut requests off sooner. So authoring runs as a
 * job the composer polls, and saving takes the job's draft, already validated
 * and restated, rather than doing that work again in the save request.
 */
import { Hono, type MiddlewareHandler } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { Authenticated, OwnsAccountByParam, OwnsMcpByParam } from '../middleware/auth'
import { getCurrentUserId } from '@shared/lib/auth/config'
import { auditRuleChange } from '@shared/lib/proxy/rules/audit-events'
import { authorRule } from '@shared/lib/proxy/rules/author'
import { RuleJobs, TooManyJobsError } from '@shared/lib/proxy/rules/jobs'
import { catalogPolicies, coverageLabels, fallbackRuleName, loadTargetContext, prepareDraft, type PreparedDraft } from '@shared/lib/proxy/rules/service'
import { createRule, deleteRule, getRule, listRules, toRuleView, type RuleTarget } from '@shared/lib/proxy/rules/store'
import { MAX_RULES_PER_TARGET, type RuleKind } from '@shared/lib/proxy/rules/engine'

const proxyRules = new Hono()
proxyRules.use('*', Authenticated())

const authorSchema = z.object({
  description: z.string().min(1).max(2000),
  clarifications: z.array(z.object({ question: z.string(), answer: z.string() })).max(10).optional(),
})

const saveSchema = z.object({
  /** The author job whose draft to save. */
  jobId: z.string().min(1),
  /** The name shown in the composer, possibly edited by the person saving. */
  name: z.string().trim().min(1).max(80).optional(),
  /** Optional: limit the rule to one agent's requests. */
  agentSlug: z.string().min(1).optional(),
})

interface AuthorOutcome {
  status: ContentfulStatusCode
  body: Record<string, unknown>
  /** The validated, restated draft a save takes; absent for questions and failures. */
  prepared?: PreparedDraft
}

const AUTHOR_WAIT_MS = 15_000
const authorJobs = new RuleJobs<AuthorOutcome>({ keepMs: 30 * 60_000, maxRunningPerOwner: 3 })

function mount(kind: RuleKind, param: 'accountId' | 'mcpId', owns: (param: string) => MiddlewareHandler) {
  const base = `/${kind}/:${param}`
  const target = (c: { req: { param: (name: string) => string | undefined } }): RuleTarget =>
    ({ kind, targetId: c.req.param(param) ?? '' })
  // Author jobs belong to the person who started them, on this connection.
  const jobOwner = (c: Parameters<typeof getCurrentUserId>[0]) =>
    `${getCurrentUserId(c)}:${kind}:${c.req.param(param) ?? ''}`

  proxyRules.get(base, owns(param), async (c) => {
    const rules = (await listRules(target(c))).map(toRuleView)
    return c.json({ rules })
  })

  proxyRules.post(`${base}/author`, owns(param), zValidator('json', authorSchema), async (c) => {
    const context = await loadTargetContext(target(c))
    if (!context) return c.json({ error: 'Not found' }, 404)
    const body = c.req.valid('json')
    const existingRules = (await listRules(target(c))).map(toRuleView)
    let jobId: string
    try {
      jobId = authorJobs.start(jobOwner(c), async (): Promise<AuthorOutcome> => {
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
          if (result.type === 'question') return { status: 200, body: result }
          const prepared = result.report.ok
            ? await prepareDraft(context, result.draft)
            : { draft: result.draft, report: result.report, name: fallbackRuleName(result.draft.description), restatement: '' }
          return {
            status: 200,
            body: {
              type: 'draft',
              draft: prepared.draft,
              name: prepared.name,
              restatement: prepared.restatement,
              report: prepared.report,
              coverage: coverageLabels(prepared.report),
              attempts: result.attempts,
            },
            prepared,
          }
        } catch (error) {
          console.error('[proxy-rules] Authoring failed:', error)
          // A result, not an HTTP error: the composer retries 5xx answers,
          // which proxies on the way also send.
          return { status: 200, body: { type: 'failed', error: error instanceof Error ? error.message : 'Rule authoring failed' } }
        }
      })
    } catch (error) {
      if (!(error instanceof TooManyJobsError)) throw error
      return c.json({ error: 'Already writing rules here. Wait for those to finish.' }, 429)
    }
    return c.json({ jobId }, 202)
  })

  proxyRules.get(`${base}/author/:jobId`, owns(param), async (c) => {
    const outcome = await authorJobs.wait(c.req.param('jobId'), jobOwner(c), AUTHOR_WAIT_MS, c.req.raw.signal)
    if (!outcome) return c.json({ error: 'This draft expired. Write the rule again.' }, 410)
    if (outcome.state === 'running') return c.json({ status: 'pending' }, 202)
    if (outcome.state === 'failed') return c.json({ type: 'failed', error: 'Rule authoring failed' })
    return c.json(outcome.value.body, outcome.value.status)
  })

  proxyRules.post(base, owns(param), zValidator('json', saveSchema), async (c) => {
    const context = await loadTargetContext(target(c))
    if (!context) return c.json({ error: 'Not found' }, 404)
    const body = c.req.valid('json')
    if ((await listRules(target(c))).length >= MAX_RULES_PER_TARGET) {
      return c.json({ error: `This connection already has ${MAX_RULES_PER_TARGET} rules. Delete one first.` }, 422)
    }
    // The draft the author job wrote, validated and restated there: what the
    // person read is what gets saved. A draft saves once; one that fails to
    // save (the cap) stays available to try again.
    const claim = authorJobs.claim(body.jobId, jobOwner(c))
    const prepared = claim?.value.prepared
    if (!claim || !prepared) {
      claim?.consume()
      return c.json({ error: 'This draft expired or is already being saved. Write the rule again if it is not in the list.' }, 410)
    }
    if (!prepared.report.ok) {
      claim.release()
      return c.json({ error: 'invalid_rule', errors: prepared.report.errors, report: prepared.report }, 422)
    }
    const { draft } = prepared
    let saved: Awaited<ReturnType<typeof createRule>>
    try {
      saved = await createRule({
        target: target(c),
        agentSlug: body.agentSlug ?? null,
        createdBy: 'user',
        createdByAgentSlug: null,
        version: {
          effect: draft.effect,
          description: draft.description,
          patterns: draft.patterns,
          code: draft.code,
          tests: draft.tests,
          name: body.name ?? prepared.name,
          restatement: prepared.restatement,
          warnings: prepared.report.warnings,
          toolSchemaHash: prepared.report.toolSchemaHash,
        },
        maxRules: MAX_RULES_PER_TARGET,
      })
    } catch (error) {
      claim.release()
      throw error
    }
    if (!saved) {
      claim.release()
      return c.json({ error: `This connection already has ${MAX_RULES_PER_TARGET} rules. Delete one first.` }, 422)
    }
    claim.consume()
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
