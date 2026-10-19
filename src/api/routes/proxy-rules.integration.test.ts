/**
 * Proxy rules end to end through the real API proxy and agent rule routes,
 * on a migrated in-memory database. Only the upstream call, the LLM
 * restatement and the session plumbing are stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as schema from '@shared/lib/db/schema'

let testDb: ReturnType<typeof drizzle>
let sqlite: InstanceType<typeof Database>
let defaultPolicy: 'allow' | 'review' | 'block' = 'review'
const upstreamCalls: Array<{ method: string; targetUrl: string }> = []

vi.mock('@shared/lib/db', () => ({ get db() { return testDb } }))
vi.mock('@shared/lib/proxy/token-store', () => ({
  validateProxyToken: async (token: string) => (token.startsWith('token-') ? token.slice(6) : null),
}))
vi.mock('@shared/lib/services/user-settings-service', () => ({
  getUserSettings: async () => ({ defaultApiPolicy: defaultPolicy, defaultMcpPolicy: defaultPolicy }),
}))
vi.mock('@shared/lib/container/message-persister', () => ({
  messagePersister: { syncAgentSessionsAwaiting: vi.fn() },
}))
vi.mock('@shared/lib/services/audit-log-service', () => ({ logAuditEvent: vi.fn() }))
vi.mock('@shared/lib/analytics/server-analytics', () => ({ trackServerEvent: vi.fn() }))
vi.mock('@shared/lib/platform-attribution', () => ({
  attribution: { fromResourceCreator: async () => ({}) },
  runWithAttribution: (_attribution: unknown, fn: () => unknown) => fn(),
  runWithRequestUser: (_userId: string, fn: () => unknown) => fn(),
}))
vi.mock('@shared/lib/account-providers', () => ({
  getAccountProviderByName: () => ({
    getConnection: async () => ({ status: 'ACTIVE' }),
    makeApiCall: async (call: { method: string; targetUrl: string }) => {
      upstreamCalls.push({ method: call.method, targetUrl: call.targetUrl })
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    },
  }),
}))
const restated = {
  name: 'Sends to @acme.com only',
  restatement: 'Allows sends when every recipient is @acme.com. Everything else goes to review.',
}
vi.mock('@shared/lib/proxy/rules/author', () => ({
  catalogFor: () => '',
  restateRule: vi.fn(async () => restated),
}))

import proxy from './proxy'
import xAgentRules, { _setProposalTimingForTest } from './x-agent-rules'
import proxyRules from './proxy-rules'
import { restateRule } from '@shared/lib/proxy/rules/author'
import { agentRegistry } from '@shared/lib/agent-actor'
import { userInputRequestManager } from '@shared/lib/tools/requests/request-manager'
import { addRuleVersion, createRule, invalidateRuleCache, listRules } from '@shared/lib/proxy/rules/store'
import { logAuditEvent } from '@shared/lib/services/audit-log-service'
import { withRuleNames } from '@shared/lib/proxy/rules/log-names'
import { normalizeProxyRequestLog } from '@shared/lib/types/request-log'

const INTERNAL_ONLY = `(req, h) => {
  const raw = req.body && typeof req.body.raw === 'string' ? h.decodeBase64(req.body.raw) : null
  const to = raw === null ? null : h.recipients(raw)
  return to !== null && to.length > 0 && to.every((a) => h.domainMatches(a.domain, 'acme.com'))
}`

const gmailTests = [
  { name: 'internal', input: send('To: a@acme.com\r\n\r\nhi'), expect: true },
  { name: 'external', input: send('To: a@evil.com\r\n\r\nhi'), expect: false },
  { name: 'display-name trick', input: send('To: "a@acme.com" <x@evil.com>\r\n\r\nhi'), expect: false },
]

function send(message: string) {
  return { method: 'POST', path: '/gmail/v1/users/me/messages/send', body: { raw: Buffer.from(message).toString('base64url') } }
}

let app: Hono

function proxySend(agent: string, message: string, path = 'gmail/v1/users/me/messages/send') {
  return app.request(`/api/proxy/${agent}/acct-gmail/gmail.googleapis.com/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer token-${agent}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: Buffer.from(message).toString('base64url') }),
  })
}

function pendingReviews(agent: string) {
  return userInputRequestManager.getAgentScopedRequests(agent)
}

async function waitForReview(agent: string) {
  for (let i = 0; i < 100; i++) {
    const [review] = pendingReviews(agent)
    if (review) return review
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('no review was raised')
}

function auditRows() {
  return testDb.select().from(schema.proxyAuditLog).all()
}

async function userRule(agentSlug: string | null = null, code = INTERNAL_ONLY, effect: 'allow' | 'require' = 'allow') {
  const saved = await createRule({
    target: { kind: 'api', targetId: 'acct-gmail' },
    agentSlug,
    createdBy: 'user',
    createdByAgentSlug: null,
    version: {
      effect, name: effect === 'allow' ? 'Internal-only sends' : 'Review external sends', description: 'internal only', restatement: 'internal only', patterns: ['POST /gmail/v1/users/*/messages/send'],
      code, tests: gmailTests, warnings: [], toolSchemaHash: null,
    },
  })
  if (!saved) throw new Error('rule was not saved')
  return saved
}

beforeEach(() => {
  sqlite = new Database(':memory:')
  testDb = drizzle(sqlite, { schema })
  migrate(testDb, { migrationsFolder: 'src/shared/lib/db/migrations' })
  defaultPolicy = 'review'
  invalidateRuleCache()
  vi.mocked(logAuditEvent).mockClear()
  upstreamCalls.length = 0
  userInputRequestManager.reset()
  const now = new Date()
  testDb.insert(schema.connectedAccounts).values({
    id: 'acct-gmail', providerConnectionId: 'ca_1', toolkitSlug: 'gmail', displayName: 'me@acme.com',
    status: 'active', createdAt: now, updatedAt: now,
  }).run()
  for (const agentSlug of ['agent-a', 'agent-b']) {
    testDb.insert(schema.agentConnectedAccounts).values({
      id: `${agentSlug}-gmail`, agentSlug, connectedAccountId: 'acct-gmail', createdAt: now,
    }).run()
  }
  app = new Hono()
  app.route('/api/proxy', proxy)
  app.route('/api/x-agent/rules', xAgentRules)
  app.route('/api/proxy-rules', proxyRules)
})

afterEach(() => {
  _setProposalTimingForTest({ waitMs: 20_000, leaseMs: 60_000 })
  userInputRequestManager.reset()
  sqlite.close()
})

describe('API proxy with rules', () => {
  it('lets a request the policy would review through when a rule allows it, and audits the rule', async () => {
    const rule = await userRule()
    const res = await proxySend('agent-a', 'To: Alice <alice@acme.com>, bob@acme.com\r\n\r\nhi')
    expect(res.status).toBe(200)
    expect(upstreamCalls).toHaveLength(1)
    expect(pendingReviews('agent-a')).toHaveLength(0)
    const [row] = auditRows()
    expect(row.policyDecision).toBe('allowed_by_rule')
    expect(row.ruleVersionId).toBe(rule.version.id)
    const [outcome] = JSON.parse(row.ruleOutcomes ?? '[]') as Array<Record<string, unknown>>
    expect(outcome).toMatchObject({ versionId: rule.version.id, effect: 'allow', result: 'true' })
    expect(outcome).not.toHaveProperty('name')
    expect(outcome).not.toHaveProperty('restatement')
    const [logged] = await withRuleNames([normalizeProxyRequestLog(row)])
    expect(JSON.parse(logged.ruleOutcomes ?? '[]')[0].name).toBe('Internal-only sends')
  })

  it('leaves an external send in review, shows the outcome, and returns the rule on deny', async () => {
    await userRule()
    const pending = proxySend('agent-a', 'To: alice@acme.com\r\nCc: "ceo@acme.com" <x@evil.com>\r\n\r\nhi')
    const review = await waitForReview('agent-a')
    const outcome = (review.payload as { ruleOutcomes?: Array<{ name: string; result: string }> }).ruleOutcomes?.[0]
    expect(outcome).toMatchObject({ name: 'Internal-only sends', result: 'false' })
    agentRegistry.get('agent-a').inputs.reviews.submit(review.id, 'deny')
    const res = await pending
    expect(res.status).toBe(403)
    const body = await res.json() as { error: string; rules: Array<Record<string, unknown>> }
    expect(body.error).toBe('denied_by_user')
    expect(body.rules).toEqual([{ id: expect.any(String), version: 1, effect: 'allow', name: 'Internal-only sends', result: 'false' }])
    expect(upstreamCalls).toHaveLength(0)
    expect(auditRows()[0].policyDecision).toBe('denied_by_user')
    expect(JSON.parse(auditRows()[0].ruleOutcomes ?? '[]')).toHaveLength(1)
  })

  it('returns an empty rules list when no rule matched', async () => {
    const pending = proxySend('agent-a', 'To: a@acme.com\r\n\r\nhi')
    const review = await waitForReview('agent-a')
    agentRegistry.get('agent-a').inputs.reviews.submit(review.id, 'deny')
    expect((await (await pending).json() as { rules: unknown[] }).rules).toEqual([])
  })

  it('never overrides a block, and never runs allow rules on requests the policy allows', async () => {
    await userRule(null, '() => true')
    defaultPolicy = 'block'
    expect((await proxySend('agent-a', 'To: a@acme.com\r\n\r\n')).status).toBe(403)
    defaultPolicy = 'allow'
    expect((await proxySend('agent-a', 'To: a@evil.com\r\n\r\n')).status).toBe(200)
    const rows = auditRows()
    expect(rows.map((r) => r.policyDecision).sort()).toEqual(['allow', 'block'])
    expect(rows.every((r) => r.ruleOutcomes === null)).toBe(true)
  })

  it('holds a request the policy allows when a require rule says review, whatever allow rules say', async () => {
    defaultPolicy = 'allow'
    const hold = await userRule(null, INTERNAL_ONLY, 'require')
    await userRule(null, '() => true')

    // Internal: the require rule passes, so the policy's allow stands.
    expect((await proxySend('agent-a', 'To: a@acme.com\r\n\r\n')).status).toBe(200)
    const [allowed] = auditRows()
    expect(allowed.policyDecision).toBe('allow')
    expect(JSON.parse(allowed.ruleOutcomes ?? '[]').map((e: { effect: string; result: string }) => [e.effect, e.result]))
      .toEqual([['require', 'true']])

    // External: held for review; the allow rule never runs.
    const pending = proxySend('agent-a', 'To: a@evil.com\r\n\r\n')
    const review = await waitForReview('agent-a')
    const outcomes = (review.payload as { ruleOutcomes?: Array<{ effect: string; name: string; result: string }> }).ruleOutcomes
    expect(outcomes).toEqual([expect.objectContaining({ effect: 'require', name: 'Review external sends', result: 'false' })])
    agentRegistry.get('agent-a').inputs.reviews.submit(review.id, 'deny')
    const res = await pending
    expect(res.status).toBe(403)
    const body = await res.json() as { rules: Array<{ effect: string; name: string }> }
    expect(body.rules).toEqual([expect.objectContaining({ effect: 'require', name: 'Review external sends' })])
    expect(upstreamCalls).toHaveLength(1)
    const denied = auditRows().find((r) => r.policyDecision === 'denied_by_user')
    expect(denied?.ruleVersionId).toBe(hold.version.id)

    // Approving a held request forwards it.
    const again = proxySend('agent-a', 'To: a@evil.com\r\n\r\n')
    agentRegistry.get('agent-a').inputs.reviews.submit((await waitForReview('agent-a')).id, 'allow')
    expect((await again).status).toBe(200)
    expect(upstreamCalls).toHaveLength(2)
  })

  it('does not read the body when no rule pattern matches', async () => {
    defaultPolicy = 'allow'
    await userRule(null, INTERNAL_ONLY, 'require')
    const res = await proxySend('agent-a', 'To: a@evil.com\r\n\r\n', 'gmail/v1/users/me/drafts')
    expect(res.status).toBe(200)
    expect(auditRows()[0].ruleOutcomes).toBeNull()
  })

  it('re-decides requests swept by an "always allow" instead of releasing them', async () => {
    await userRule(null, INTERNAL_ONLY, 'require')
    // Both wait for review under the default policy; the external one is also
    // held by the require rule.
    const external = proxySend('agent-a', 'To: a@evil.com\r\n\r\n')
    const externalReview = await waitForReview('agent-a')
    const internal = proxySend('agent-a', 'To: a@acme.com\r\n\r\n')
    let internalReview = pendingReviews('agent-a').find((r) => r.id !== externalReview.id)
    for (let i = 0; !internalReview && i < 100; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5))
      internalReview = pendingReviews('agent-a').find((r) => r.id !== externalReview.id)
    }
    expect(internalReview).toBeDefined()

    // "Always allow gmail.send": the policy changes, then pending siblings are swept.
    const now = new Date()
    testDb.insert(schema.apiScopePolicies).values({
      id: 'p-send', accountId: 'acct-gmail', scope: 'gmail.send', decision: 'allow', createdAt: now, updatedAt: now,
    }).run()
    agentRegistry.get('agent-a').inputs.reviews.resolveMatching('gmail.send', 'allow')

    // The internal send is decided again (now allowed) and goes out; the
    // external one is still held by the rule.
    expect((await internal).status).toBe(200)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(pendingReviews('agent-a').map((r) => r.id)).toEqual([externalReview.id])
    agentRegistry.get('agent-a').inputs.reviews.submit(externalReview.id, 'deny')
    expect((await external).status).toBe(403)
    expect(upstreamCalls).toHaveLength(1)
  })

  it('answers at once when rules cannot be loaded for a request the policy allows', async () => {
    defaultPolicy = 'allow'
    sqlite.exec('DROP TABLE proxy_rule_versions')
    const started = Date.now()
    const res = await proxySend('agent-a', 'To: a@acme.com\r\n\r\n')
    expect(res.status).toBe(503)
    expect((await res.json() as { error: string }).error).toBe('rules_unavailable')
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(upstreamCalls).toHaveLength(0)
    expect(auditRows()[0].policyDecision).toBe('rules_unavailable')

    // A request the policy reviews anyway still goes to review.
    defaultPolicy = 'review'
    const pending = proxySend('agent-a', 'To: a@acme.com\r\n\r\n')
    agentRegistry.get('agent-a').inputs.reviews.submit((await waitForReview('agent-a')).id, 'deny')
    expect((await pending).status).toBe(403)
  })

  it('applies an agent-scoped rule only to that agent', async () => {
    await userRule('agent-a')
    expect((await proxySend('agent-a', 'To: a@acme.com\r\n\r\n')).status).toBe(200)
    const pending = proxySend('agent-b', 'To: a@acme.com\r\n\r\n')
    const review = await waitForReview('agent-b')
    agentRegistry.get('agent-b').inputs.reviews.submit(review.id, 'deny')
    expect((await pending).status).toBe(403)
  })

  it('rejects dot segments before any policy or rule runs', async () => {
    await userRule(null, '() => true')
    const res = await proxySend('agent-a', 'To: a@evil.com\r\n\r\n', 'gmail/v1/users/me/drafts%2F..%2Fmessages/send')
    expect(res.status).toBe(400)
    expect(upstreamCalls).toHaveLength(0)
  })
})

describe('agent rule tools', () => {
  function call(agent: string, op: string, body: unknown) {
    return app.request(`/api/x-agent/rules/${op}`, {
      method: 'POST',
      headers: { Authorization: `Bearer token-${agent}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  /** What the agent tool does: submit, then wait on the proposal until it settles. */
  async function propose(agent: string, op: 'create' | 'delete', body: unknown) {
    let res = await call(agent, op, body)
    if (res.status !== 202) return res
    const { proposalId } = await res.json() as { proposalId: string }
    while (res.status === 202) res = await call(agent, 'wait', { proposalId })
    return res
  }

  const draft = {
    kind: 'api', targetId: 'acct-gmail', description: 'Send only to @acme.com',
    patterns: ['POST /gmail/v1/users/*/messages/send'], code: INTERNAL_ONLY, tests: gmailTests,
  }

  it('returns failing drafts to the agent without asking the user', async () => {
    const res = await propose('agent-a', 'create', { ...draft, tests: [{ ...gmailTests[1], expect: true }, gmailTests[0]] })
    expect(res.status).toBe(422)
    const body = await res.json() as { failedTests: Array<{ name: string }> }
    expect(body.failedTests.map((t) => t.name)).toEqual(['external'])
    expect(pendingReviews('agent-a')).toHaveLength(0)
  })

  it('saves an approved rule scoped to the proposing agent, with the host restatement', async () => {
    const pending = propose('agent-a', 'create', draft)
    const review = await waitForReview('agent-a')
    const proposal = (review.payload as { ruleProposal: { name: string; restatement: string; tests: Array<{ passed: boolean }>; coverage: string[] } }).ruleProposal
    expect(proposal.name).toBe('Sends to @acme.com only')
    expect(proposal.restatement).toMatch(/@acme.com/)
    expect(proposal.tests.every((t) => t.passed)).toBe(true)
    expect(proposal.coverage[0]).toMatch(/^POST \/gmail\/v1\/users\/\*\/messages\/send/)
    agentRegistry.get('agent-a').inputs.reviews.submit(review.id, 'allow')
    const res = await pending
    expect(res.status).toBe(200)
    const [saved] = await listRules({ kind: 'api', targetId: 'acct-gmail' })
    expect(saved.rule.agentSlug).toBe('agent-a')
    expect(saved.rule.createdBy).toBe('agent')
    expect(saved.version.restatement).toMatch(/@acme.com/)
    expect(saved.version.name).toBe('Sends to @acme.com only')
    expect(logAuditEvent).toHaveBeenCalledWith({
      userId: null,
      object: 'proxy_rule',
      objectId: 'acct-gmail',
      action: 'created',
      details: expect.objectContaining({
        ruleId: saved.rule.id, name: 'Sends to @acme.com only', effect: 'allow', version: 1,
        appliesTo: 'agent', by: 'agent', agentSlug: 'agent-a',
      }),
    })

    // The new rule now lets the agent's internal sends through.
    expect((await proxySend('agent-a', 'To: a@acme.com\r\n\r\n')).status).toBe(200)
  })

  it('saves a require rule an agent proposes with its effect', async () => {
    const pending = propose('agent-a', 'create', { ...draft, effect: 'require' })
    const review = await waitForReview('agent-a')
    const proposal = (review.payload as { ruleProposal: { effect: string; warnings: string[] } }).ruleProposal
    expect(proposal.effect).toBe('require')
    expect(proposal.warnings.some((w) => w.startsWith('A require rule only holds'))).toBe(true)
    agentRegistry.get('agent-a').inputs.reviews.submit(review.id, 'allow')
    expect((await pending).status).toBe(200)
    const [saved] = await listRules({ kind: 'api', targetId: 'acct-gmail' })
    expect(saved.version.effect).toBe('require')

    defaultPolicy = 'allow'
    const held = proxySend('agent-a', 'To: a@evil.com\r\n\r\n')
    agentRegistry.get('agent-a').inputs.reviews.submit((await waitForReview('agent-a')).id, 'deny')
    expect((await held).status).toBe(403)
    expect((await proxySend('agent-b', 'To: a@evil.com\r\n\r\n')).status).toBe(200)
  })

  it('does not save a rejected rule', async () => {
    const pending = propose('agent-a', 'create', draft)
    const review = await waitForReview('agent-a')
    agentRegistry.get('agent-a').inputs.reviews.submit(review.id, 'deny')
    expect((await pending).status).toBe(403)
    expect(await listRules({ kind: 'api', targetId: 'acct-gmail' })).toEqual([])
  })

  it('lists without approval, showing code only for the agent\'s own rules', async () => {
    const shared = await userRule()
    await userRule('agent-b')
    const created = propose('agent-a', 'create', draft)
    agentRegistry.get('agent-a').inputs.reviews.submit((await waitForReview('agent-a')).id, 'allow')
    expect((await created).status).toBe(200)

    const list = await (await call('agent-a', 'list', { kind: 'api', targetId: 'acct-gmail' })).json() as { rules: Array<Record<string, unknown>> }
    expect(list.rules).toHaveLength(2)
    const [user, own] = list.rules
    expect(user).toEqual({ id: shared.rule.id, effect: 'allow', name: 'Internal-only sends', version: 1, createdBy: 'user', appliesTo: 'all_agents' })
    expect(own.code).toBe(INTERNAL_ONLY)
    expect((await call('agent-c', 'list', { kind: 'api', targetId: 'acct-gmail' })).status).toBe(404)
  })

  it('deletes only with the user\'s approval, and never another agent\'s rule', async () => {
    const shared = await userRule(null, INTERNAL_ONLY, 'require')
    const others = await userRule('agent-b')
    expect((await propose('agent-a', 'delete', { ruleId: others.rule.id })).status).toBe(404)

    // Kept: the user says no.
    const kept = propose('agent-a', 'delete', { ruleId: shared.rule.id })
    const keepReview = await waitForReview('agent-a')
    const proposal = (keepReview.payload as { ruleProposal: { deletesRuleId: string; effect: string; warnings: string[] } }).ruleProposal
    expect(proposal.deletesRuleId).toBe(shared.rule.id)
    expect(proposal.effect).toBe('require')
    expect(proposal.warnings[0]).toMatch(/without review/)
    agentRegistry.get('agent-a').inputs.reviews.submit(keepReview.id, 'deny')
    expect((await kept).status).toBe(403)
    expect((await listRules({ kind: 'api', targetId: 'acct-gmail' })).map((r) => r.rule.id)).toContain(shared.rule.id)

    // Deleted: the user approves.
    const deleted = propose('agent-a', 'delete', { ruleId: shared.rule.id })
    agentRegistry.get('agent-a').inputs.reviews.submit((await waitForReview('agent-a')).id, 'allow')
    expect((await deleted).status).toBe(200)
    expect((await listRules({ kind: 'api', targetId: 'acct-gmail' })).map((r) => r.rule.id)).toEqual([others.rule.id])
    expect(vi.mocked(logAuditEvent).mock.calls.map(([event]) => [event.action, (event.details as { ruleId?: string }).ruleId])).toEqual([
      ['deleted', shared.rule.id],
    ])
  })

  it('deletes only the version the user was shown', async () => {
    const rule = await userRule()
    const pending = propose('agent-a', 'delete', { ruleId: rule.rule.id })
    const review = await waitForReview('agent-a')
    // The rule becomes a require rule while the deletion card is open.
    const replaced = await addRuleVersion(rule.rule.id, {
      effect: 'require', name: 'Review external sends', description: 'review external', restatement: 'review external',
      patterns: ['POST /gmail/v1/users/*/messages/send'], code: INTERNAL_ONLY, tests: gmailTests, warnings: [], toolSchemaHash: null,
    })
    expect(replaced?.version.version).toBe(2)
    agentRegistry.get('agent-a').inputs.reviews.submit(review.id, 'allow')
    const res = await pending
    expect(res.status).toBe(409)
    expect((await res.json() as { error: string }).error).toBe('rule_changed')
    const [still] = await listRules({ kind: 'api', targetId: 'acct-gmail' })
    expect(still.version.effect).toBe('require')
  })

  it('replaces only the version the user was shown', async () => {
    const created = propose('agent-a', 'create', draft)
    agentRegistry.get('agent-a').inputs.reviews.submit((await waitForReview('agent-a')).id, 'allow')
    expect((await created).status).toBe(200)
    const [rule] = await listRules({ kind: 'api', targetId: 'acct-gmail' })

    const pending = propose('agent-a', 'create', { ...draft, replacesRuleId: rule.rule.id })
    const review = await waitForReview('agent-a')
    await addRuleVersion(rule.rule.id, {
      effect: 'require', name: 'Changed meanwhile', description: 'x', restatement: 'x',
      patterns: ['POST /gmail/v1/users/*/messages/send'], code: INTERNAL_ONLY, tests: gmailTests, warnings: [], toolSchemaHash: null,
    })
    agentRegistry.get('agent-a').inputs.reviews.submit(review.id, 'allow')
    expect((await pending).status).toBe(409)
    const [after] = await listRules({ kind: 'api', targetId: 'acct-gmail' })
    expect(after.version.version).toBe(2)
    expect(after.version.name).toBe('Changed meanwhile')
  })

  it('holds the cap when proposals are approved concurrently', async () => {
    for (let i = 0; i < 19; i++) await userRule()
    const first = propose('agent-a', 'create', draft)
    const firstReview = await waitForReview('agent-a')
    const second = propose('agent-a', 'create', draft)
    let secondReview = pendingReviews('agent-a').find((r) => r.id !== firstReview.id)
    for (let i = 0; !secondReview && i < 100; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5))
      secondReview = pendingReviews('agent-a').find((r) => r.id !== firstReview.id)
    }
    agentRegistry.get('agent-a').inputs.reviews.submit(firstReview.id, 'allow')
    agentRegistry.get('agent-a').inputs.reviews.submit(secondReview!.id, 'allow')
    const statuses = [(await first).status, (await second).status].sort()
    expect(statuses).toEqual([200, 409])
    expect(await listRules({ kind: 'api', targetId: 'acct-gmail' })).toHaveLength(20)
  })

  it('answers at once with a proposal only its agent can wait on or withdraw', async () => {
    _setProposalTimingForTest({ waitMs: 20 })
    const res = await call('agent-a', 'create', draft)
    expect(res.status).toBe(202)
    const { proposalId } = await res.json() as { proposalId: string }
    await waitForReview('agent-a')

    expect((await call('agent-a', 'wait', { proposalId })).status).toBe(202)
    expect((await call('agent-b', 'wait', { proposalId })).status).toBe(404)
    expect(await (await call('agent-b', 'cancel', { proposalId })).json()).toEqual({ ok: false })
    expect(pendingReviews('agent-a')).toHaveLength(1)

    expect(await (await call('agent-a', 'cancel', { proposalId })).json()).toEqual({ ok: true })
    let settled = await call('agent-a', 'wait', { proposalId })
    for (let i = 0; settled.status === 202 && i < 50; i++) settled = await call('agent-a', 'wait', { proposalId })
    expect(settled.status).toBe(408)
    expect(pendingReviews('agent-a')).toHaveLength(0)
    expect(await listRules({ kind: 'api', targetId: 'acct-gmail' })).toEqual([])
  })

  it('withdraws the card of a proposal its agent stopped waiting for', async () => {
    // The agent polls until its card is up, then stops. Polling is what holds
    // the lease, so the card comes up however long preparing it takes; a bare
    // 30 ms lease lapsed first on a loaded runner, and the proposal was
    // abandoned before any card existed (the next test's case, not this one).
    _setProposalTimingForTest({ leaseMs: 200, waitMs: 10 })
    const res = await call('agent-a', 'create', draft)
    expect(res.status).toBe(202)
    const { proposalId } = await res.json() as { proposalId: string }
    await vi.waitFor(async () => {
      expect((await call('agent-a', 'wait', { proposalId })).status).toBe(202)
      expect(pendingReviews('agent-a')).toHaveLength(1)
    }, { timeout: 10_000, interval: 20 })

    await vi.waitFor(() => expect(pendingReviews('agent-a')).toHaveLength(0), { timeout: 10_000 })
    expect(await listRules({ kind: 'api', targetId: 'acct-gmail' })).toEqual([])
  })

  it('raises no card for a proposal abandoned while it was being prepared', async () => {
    // The cloud case: a proxy cut the agent off during the restatement, and
    // the agent asked again. The first proposal must not reach the user.
    _setProposalTimingForTest({ leaseMs: 30 })
    vi.mocked(restateRule).mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80))
      return restated
    })
    expect((await call('agent-a', 'create', draft)).status).toBe(202)
    await vi.waitFor(() => expect(vi.mocked(logAuditEvent).mock.calls.map(([event]) => event.action)).toContain('rejected'))
    expect(pendingReviews('agent-a')).toHaveLength(0)
    expect(await listRules({ kind: 'api', targetId: 'acct-gmail' })).toEqual([])
  })

  it('caps rules per connection', async () => {
    for (let i = 0; i < 20; i++) await userRule()
    const res = await propose('agent-a', 'create', draft)
    expect(res.status).toBe(422)
    expect((await res.json() as { error: string }).error).toBe('too_many_rules')
    expect(pendingReviews('agent-a')).toHaveLength(0)
  })
})

describe('rules in the app', () => {
  const base = '/api/proxy-rules/api/acct-gmail'

  it('lists every rule on the connection and deletes one', async () => {
    const shared = await userRule()
    await userRule('agent-a')
    const listed = await (await app.request(base)).json() as { rules: Array<{ id: string; agentSlug: string | null }> }
    expect(listed.rules.map((r) => r.agentSlug).sort()).toEqual(['agent-a', null].sort())

    expect((await app.request(`${base}/${shared.rule.id}`, { method: 'DELETE' })).status).toBe(200)
    expect((await listRules({ kind: 'api', targetId: 'acct-gmail' })).map((r) => r.rule.agentSlug)).toEqual(['agent-a'])
  })

  it('deletes only rules on the connection in the path', async () => {
    const rule = await userRule()
    expect((await app.request(`/api/proxy-rules/mcp/acct-gmail/${rule.rule.id}`, { method: 'DELETE' })).status).toBe(404)
    expect(await listRules({ kind: 'api', targetId: 'acct-gmail' })).toHaveLength(1)
  })
})
