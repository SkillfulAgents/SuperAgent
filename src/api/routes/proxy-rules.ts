/**
 * User-facing proxy rule endpoints, per connected account (/api/:accountId)
 * or remote MCP server (/mcp/:mcpId):
 *   GET    /:kind/:id            list live rules
 *   DELETE /:kind/:id/:ruleId    soft-delete a rule
 *
 * Rules are written by agents: the app's rules box starts a chat that asks an
 * agent for one, and the agent proposes it for the person to approve (see
 * x-agent-rules).
 */
import { Hono, type MiddlewareHandler } from 'hono'
import { Authenticated, OwnsAccountByParam, OwnsMcpByParam } from '../middleware/auth'
import { getCurrentUserId } from '@shared/lib/auth/config'
import { auditRuleChange } from '@shared/lib/proxy/rules/audit-events'
import { deleteRule, getRule, listRules, toRuleView, type RuleTarget } from '@shared/lib/proxy/rules/store'
import type { RuleKind } from '@shared/lib/proxy/rules/engine'

const proxyRules = new Hono()
proxyRules.use('*', Authenticated())

function mount(kind: RuleKind, param: 'accountId' | 'mcpId', owns: (param: string) => MiddlewareHandler) {
  const base = `/${kind}/:${param}`
  const target = (c: { req: { param: (name: string) => string | undefined } }): RuleTarget =>
    ({ kind, targetId: c.req.param(param) ?? '' })

  proxyRules.get(base, owns(param), async (c) => {
    const rules = (await listRules(target(c))).map(toRuleView)
    return c.json({ rules })
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
