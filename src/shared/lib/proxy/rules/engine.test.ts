import { describe, expect, it } from 'vitest'
import { globMatches, hasDotSegment, matchesAnyApiPattern, matchesToolPattern, parseApiPattern } from './patterns'
import { evaluateRules, toolSchemaHash, validateRuleDraft, type ActiveRule, type RuleDraft } from './engine'
import { buildApiRuleInput, buildMcpRuleInput } from './input'

describe('API patterns', () => {
  const m = (pattern: string, method: string, path: string) => matchesAnyApiPattern([pattern], method, path)

  it('matches methods, single segments and partial segments', async () => {
    expect(m('POST /gmail/v1/users/*/messages/send', 'post', '/gmail/v1/users/me/messages/send')).toBe(true)
    expect(m('POST /gmail/v1/users/*/messages/send', 'PUT', '/gmail/v1/users/me/messages/send')).toBe(false)
    expect(m('* /v1/pages/*', 'PATCH', '/v1/pages/abc')).toBe(true)
    expect(m('GET /files/msg*', 'GET', '/files/msg123')).toBe(true)
    expect(m('GET /files/*', 'GET', '/files/a/b')).toBe(false)
    expect(m('GET /files/*', 'GET', '/files/')).toBe(false)
  })

  it('matches ** across zero or more segments', async () => {
    expect(m('POST /upload/**', 'POST', '/upload')).toBe(true)
    expect(m('POST /upload/**', 'POST', '/upload/gmail/v1/users/me/messages/send')).toBe(true)
    expect(m('POST /**/send', 'POST', '/gmail/v1/users/me/messages/send')).toBe(true)
    expect(m('POST /**/send', 'POST', '/gmail/v1/users/me/messages/sendx')).toBe(false)
  })

  it('rejects malformed patterns', async () => {
    expect(parseApiPattern('/no/method').ok).toBe(false)
    expect(parseApiPattern('FETCH /x').ok).toBe(false)
    expect(parseApiPattern('GET /x?y=1').ok).toBe(false)
    expect(parseApiPattern('GET /a/../b').ok).toBe(false)
    expect(parseApiPattern('GET /a/b**').ok).toBe(false)
  })

  it('detects dot segments', async () => {
    expect(hasDotSegment('/gmail/v1/users/me/drafts/../messages/send')).toBe(true)
    expect(hasDotSegment('/a/./b')).toBe(true)
    expect(hasDotSegment('/a/..b/c')).toBe(false)
  })
})

describe('matching cost', () => {
  // The regex implementation these replace took ~2.9 s on 80 characters.
  it('matches adversarial globs in linear time', async () => {
    const started = performance.now()
    expect(matchesToolPattern('*a*a*a*a*a*a*b', 'a'.repeat(100_000))).toBe(false)
    expect(matchesAnyApiPattern(['POST /x/*a*a*a*a*a*a*b'], 'POST', `/x/${'a'.repeat(10_000)}`)).toBe(false)
    expect(matchesAnyApiPattern(['POST /**/a/**/a/**/a/**/b'], 'POST', '/a'.repeat(4_000))).toBe(false)
    expect(performance.now() - started).toBeLessThan(500)
  })

  it('matches ** over very long paths without recursion', async () => {
    expect(matchesAnyApiPattern(['GET /**/end'], 'GET', '/x'.repeat(20_000) + '/end')).toBe(true)
  })

  it('agrees with regular-expression globs', async () => {
    const toRegex = (pattern: string, star: string) => new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(star)}$`)
    const alphabet = ['a', 'b', '*']
    let seed = 7
    const random = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n }
    for (let i = 0; i < 3_000; i++) {
      const pattern = Array.from({ length: 1 + random(6) }, () => alphabet[random(3)]).join('')
      const text = Array.from({ length: random(8) }, () => alphabet[random(2)]).join('')
      expect(globMatches(pattern, text, 0), `${pattern} ~ ${text}`).toBe(toRegex(pattern, '.*').test(text))
      expect(globMatches(pattern, text, 1), `${pattern} ~+ ${text}`).toBe(toRegex(pattern, '.+').test(text))
    }
  })
})

describe('tool patterns', () => {
  it('globs tool names', async () => {
    expect(matchesToolPattern('notion-update-*', 'notion-update-page')).toBe(true)
    expect(matchesToolPattern('requestSendMoney', 'requestSendMoney')).toBe(true)
    expect(matchesToolPattern('requestSendMoney', 'requestSendMoneyNow')).toBe(false)
  })
})

const INTERNAL_ONLY = `(req, h) => {
  const raw = req.body && typeof req.body.raw === 'string' ? h.decodeBase64(req.body.raw) : null
  const to = raw === null ? null : h.recipients(raw)
  return to !== null && to.length > 0 && to.every((a) => h.domainMatches(a.domain, 'acme.com'))
}`

function gmailSend(message: string): Record<string, unknown> {
  return {
    method: 'POST',
    path: '/gmail/v1/users/me/messages/send',
    body: { raw: Buffer.from(message).toString('base64url') },
  }
}

const gmailDraft: RuleDraft = {
  kind: 'api',
  effect: 'allow',
  description: 'Send email only to @acme.com recipients',
  patterns: ['POST /gmail/v1/users/*/messages/send'],
  code: INTERNAL_ONLY,
  tests: [
    { name: 'internal', input: gmailSend('To: a@acme.com\r\n\r\nhi'), expect: true },
    { name: 'external cc', input: gmailSend('To: a@acme.com\r\nCc: b@evil.com\r\n\r\nhi'), expect: false },
    { name: 'display-name trick', input: gmailSend('To: "a@acme.com" <x@evil.com>\r\n\r\nhi'), expect: false },
    { name: 'lookalike', input: gmailSend('To: a@evilacme.com\r\n\r\nhi'), expect: false },
    { name: 'no recipients', input: gmailSend('Subject: x\r\n\r\nhi'), expect: false },
  ],
}

describe('validateRuleDraft', () => {
  it('passes a correct Gmail rule and lists the endpoints it covers', async () => {
    const report = await validateRuleDraft(gmailDraft, { toolkit: 'gmail' })
    expect(report.errors).toEqual([])
    expect(report.ok).toBe(true)
    expect(report.testResults.every((r) => r.passed)).toBe(true)
    expect(report.coverage).toEqual([
      expect.objectContaining({ method: 'POST', path: '/gmail/v1/users/*/messages/send' }),
    ])
    expect(report.warnings).toEqual([])
  })

  it('flags the vacuous [].every bug through the empty-body probe', async () => {
    const vacuous = { ...gmailDraft, code: `(req, h) => {
      const raw = req.body && req.body.raw ? h.decodeBase64(req.body.raw) : ''
      return (h.recipients(raw) || []).every((a) => h.domainMatches(a.domain, 'acme.com'))
    }`, tests: gmailDraft.tests.filter((t) => t.name !== 'no recipients') }
    const report = await validateRuleDraft(vacuous, { toolkit: 'gmail' })
    expect(report.ok).toBe(true)
    expect(report.warnings.some((w) => w.startsWith('Allows an empty-body POST'))).toBe(true)
  })

  it('fails tests that never reach the rule and wrong expectations', async () => {
    const report = await validateRuleDraft({
      ...gmailDraft,
      tests: [
        { name: 'wrong path', input: { ...gmailSend('To: a@acme.com\r\n\r\n'), path: '/gmail/v1/users/me/drafts/send' }, expect: true },
        { name: 'wrong expectation', input: gmailSend('To: a@evil.com\r\n\r\n'), expect: true },
        { name: 'ok', input: gmailSend('To: a@evil.com\r\n\r\n'), expect: false },
      ],
    }, { toolkit: 'gmail' })
    expect(report.ok).toBe(false)
    expect(report.testResults.map((r) => r.passed)).toEqual([false, false, true])
    expect(report.testResults[0].error).toMatch(/matches none of the rule's patterns/)
  })

  it('warns on wide ** patterns that reach destructive endpoints', async () => {
    const report = await validateRuleDraft({ ...gmailDraft, patterns: ['* /gmail/v1/users/*/**'] }, { toolkit: 'gmail' })
    expect(report.warnings).toContain('The patterns cover destructive endpoints.')
    expect((report.coverage as unknown[]).length).toBeGreaterThan(20)
  })

  it('rejects drafts without both an allow and a review test', async () => {
    const report = await validateRuleDraft({ ...gmailDraft, tests: [gmailDraft.tests[0]] }, { toolkit: 'gmail' })
    expect(report.errors).toContain('Include at least one test that goes to review (expect: false).')
  })

  it('validates MCP drafts against the current tools', async () => {
    const tools = [
      { name: 'requestSendMoney', inputSchema: { type: 'object', properties: { amount: { type: 'number' } } } },
      { name: 'listAccounts' },
    ]
    const report = await validateRuleDraft({
      kind: 'mcp',
      effect: 'allow',
      description: 'Payment requests up to $5,000',
      patterns: ['requestSendMoney'],
      code: '(req, h) => { const n = h.toNumber(req.args && req.args.amount); return n !== null && n > 0 && n <= 5000 }',
      tests: [
        { name: 'under', input: { tool: 'requestSendMoney', args: { amount: 4999 } }, expect: true },
        { name: 'over', input: { tool: 'requestSendMoney', args: { amount: 5000.01 } }, expect: false },
        { name: 'string', input: { tool: 'requestSendMoney', args: { amount: '1e4' } }, expect: false },
      ],
    }, { tools })
    expect(report.ok).toBe(true)
    expect(report.coverage).toEqual(['requestSendMoney'])
    expect(report.toolSchemaHash).toBe(toolSchemaHash(['requestSendMoney'], tools))
  })
})

describe('evaluateRules', () => {
  const rule = (overrides: Partial<ActiveRule>): ActiveRule => ({
    ruleId: 'r1', versionId: 'v1', version: 1, kind: 'api', effect: 'allow', name: 'Internal-only sends', restatement: 'internal only',
    patterns: gmailDraft.patterns, code: INTERNAL_ONLY, toolSchemaHash: null, ...overrides,
  })

  function sendInput(message: string) {
    const body = new TextEncoder().encode(JSON.stringify({ raw: Buffer.from(message).toString('base64url') }))
    return buildApiRuleInput({
      method: 'POST', host: 'gmail.googleapis.com', path: '/gmail/v1/users/me/messages/send', search: '',
      headers: new Headers({ 'content-type': 'application/json', authorization: 'Bearer secret' }),
      body: body.buffer as ArrayBuffer,
    })
  }

  it('allows on the first true and records every rule that ran', async () => {
    const rules = [rule({ ruleId: 'never', versionId: 'vn', code: '() => false' }), rule({})]
    const result = await evaluateRules(rules, sendInput('To: a@acme.com\r\n\r\n'), 'review')
    expect(result.decision).toBe('allow')
    expect(result.allowedBy?.ruleId).toBe('r1')
    expect(result.evaluations.map((e) => [e.ruleId, e.outcome.result])).toEqual([['never', 'false'], ['r1', 'true']])
  })

  it('leaves non-matching requests alone and keeps external sends in review', async () => {
    const notMatched = await evaluateRules([rule({})], buildApiRuleInput({
      method: 'POST', host: 'gmail.googleapis.com', path: '/gmail/v1/users/me/drafts/send', search: '',
      headers: new Headers(), body: null,
    }), 'review')
    expect(notMatched).toEqual({ decision: 'review', allowedBy: null, heldBy: null, evaluations: [] })
    const external = await evaluateRules([rule({})], sendInput('To: a@evil.com\r\n\r\n'), 'review')
    expect(external.decision).toBe('review')
    expect(external.allowedBy).toBeNull()
    expect(external.evaluations[0].outcome.result).toBe('false')
  })

  it('never shows credentials to rules', async () => {
    expect(sendInput('To: a@acme.com\r\n\r\n').headers.authorization).toBeUndefined()
    const input = buildApiRuleInput({
      method: 'GET', host: 'api.example.com', path: '/x', search: '', body: null,
      headers: new Headers({
        'api-key': 'k1', 'x-goog-api-key': 'k2', 'x-amz-security-token': 't1', 'x-custom-token': 't2',
        'x-session-id': 's1', 'private-token': 'p1', cookie: 'c=1', accept: 'application/json',
      }),
    })
    expect(input.headers).toEqual({ accept: 'application/json' })
  })

  it('caps MCP arguments like API bodies', async () => {
    const small = buildMcpRuleInput({ tool: 'send', args: { amount: 5 } })
    expect(small).toMatchObject({ args: { amount: 5 }, argsTruncated: false })
    const big = buildMcpRuleInput({ tool: 'send', args: { blob: 'x'.repeat(6 * 1024 * 1024) } })
    expect(big).toMatchObject({ args: null, argsTruncated: true })
  })

  it('stops a request\'s rules once its time budget is spent', async () => {
    const slow = rule({ ruleId: 'slow', versionId: 'vs', effect: 'require', code: '() => { for (;;) {} }' })
    const next = rule({ ruleId: 'next', versionId: 'vx', code: '() => true' })
    const result = await evaluateRules([slow, next], sendInput('To: a@acme.com\r\n\r\n'), 'review', { budgetMs: 1 })
    expect(result.decision).toBe('review')
    expect(result.heldBy?.outcome.result).toMatch(/timeout|budget_exceeded/)
    expect(result.evaluations.map((e) => e.ruleId)).toEqual(['slow'])
  })

  it('skips MCP rules whose tool schema changed', async () => {
    const mcpRule = rule({ kind: 'mcp', patterns: ['requestSendMoney'], code: '() => true', toolSchemaHash: 'old' })
    const input = buildMcpRuleInput({ tool: 'requestSendMoney', args: { amount: 1 } })
    expect((await evaluateRules([mcpRule], input, 'review', { currentToolSchemaHash: () => 'new' })).evaluations[0].outcome)
      .toEqual({ result: 'schema_changed' })
    expect((await evaluateRules([mcpRule], input, 'review', { currentToolSchemaHash: () => 'old' })).allowedBy?.ruleId).toBe('r1')
    const requireRule = { ...mcpRule, effect: 'require' as const }
    expect((await evaluateRules([requireRule], input, 'allow', { currentToolSchemaHash: () => 'new' })).heldBy?.outcome)
      .toEqual({ result: 'schema_changed' })
  })

  it('runs allow rules only when the policy reviews, and require rules either way', async () => {
    const allowRule = rule({ code: '() => true' })
    const requireRule = rule({ ruleId: 'req', versionId: 'vr', effect: 'require' })
    const external = sendInput('To: a@evil.com\r\n\r\n')
    const internal = sendInput('To: a@acme.com\r\n\r\n')

    // Policy allows: allow rules don't run; a require rule holds the external send.
    expect(await evaluateRules([allowRule], external, 'allow')).toEqual({ decision: 'allow', allowedBy: null, heldBy: null, evaluations: [] })
    const held = await evaluateRules([allowRule, requireRule], external, 'allow')
    expect(held.decision).toBe('review')
    expect(held.heldBy?.ruleId).toBe('req')
    expect(held.evaluations.map((e) => e.ruleId)).toEqual(['req'])
    const passed = await evaluateRules([requireRule], internal, 'allow')
    expect(passed.decision).toBe('allow')
    expect(passed.evaluations.map((e) => [e.ruleId, e.outcome.result])).toEqual([['req', 'true']])

    // Policy reviews: a held request stays in review whatever the allow rules say.
    const reviewedHeld = await evaluateRules([allowRule, requireRule], external, 'review')
    expect(reviewedHeld).toMatchObject({ decision: 'review', allowedBy: null, heldBy: { ruleId: 'req' } })
    expect(reviewedHeld.evaluations.map((e) => e.ruleId)).toEqual(['req'])
    expect(await evaluateRules([allowRule, requireRule], internal, 'review'))
      .toMatchObject({ decision: 'allow', allowedBy: { ruleId: 'r1' }, heldBy: null })
  })

  it('holds a request when a require rule throws, times out or returns a non-boolean', async () => {
    const external = sendInput('To: a@acme.com\r\n\r\n')
    for (const code of ['() => { throw new Error("x") }', '() => { while (true) {} }', '() => 1', '() => "true"']) {
      const result = await evaluateRules([rule({ effect: 'require', code })], external, 'allow')
      expect(result.decision, code).toBe('review')
      expect(result.heldBy?.outcome.result, code).not.toBe('true')
    }
  })
})

describe('coverage', () => {
  it('counts a rule narrower than a catalog entry as covering it', async () => {
    const report = await validateRuleDraft({
      kind: 'api',
      effect: 'allow',
      description: 'primary calendar events',
      patterns: ['GET /calendar/v3/calendars/primary/events'],
      code: '(req) => req.query.ok === "1"',
      tests: [
        { name: 'ok', input: { method: 'GET', path: '/calendar/v3/calendars/primary/events', query: { ok: '1' } }, expect: true },
        { name: 'not ok', input: { method: 'GET', path: '/calendar/v3/calendars/primary/events' }, expect: false },
      ],
    }, { toolkit: 'googlecalendar' })
    expect((report.coverage as Array<{ path: string }>).map((c) => c.path)).toContain('/calendar/v3/calendars/*/events')
    expect(report.warnings).toEqual([])
  })

  it('stops validating at the first timeout, so a looping draft costs one time limit', async () => {
    const tests = Array.from({ length: 100 }, (_, i) => ({ ...gmailDraft.tests[i % gmailDraft.tests.length], name: `case ${i}` }))
    const started = performance.now()
    const report = await validateRuleDraft({ ...gmailDraft, code: '() => { for (;;) {} }', tests }, { toolkit: 'gmail' })
    expect(performance.now() - started).toBeLessThan(2_000)
    expect(report.ok).toBe(false)
    expect(report.testResults).toHaveLength(1)
    expect(report.testResults[0].error).toMatch(/time limit/)
    expect(report.errors.some((e) => e.startsWith('Validation stopped'))).toBe(true)
  })

  it('warns that a require rule only holds what its patterns match', async () => {
    const report = await validateRuleDraft({ ...gmailDraft, effect: 'require' }, { toolkit: 'gmail' })
    expect(report.ok).toBe(true)
    expect(report.warnings.some((w) => w.startsWith('A require rule only holds requests its patterns match'))).toBe(true)
  })
})
