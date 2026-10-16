/**
 * Live validation of proxy rules against real connected accounts.
 *
 * Gated: PROXY_RULES_LIVE=1. Needs
 *   LIVE_PLATFORM_TOKEN      platform access token (Composio via the platform proxy)
 *   PLATFORM_PROXY_URL       e.g. https://platformproxy.gamutagents.com
 *   LIVE_ANTHROPIC_API_KEY   for rule authoring + restatements
 *   LIVE_ACCOUNTS            JSON { gmail: [ca_…], googlecalendar: ca_…, slack: ca_…, github: ca_… }
 *   LIVE_AUTHOR_MODELS       comma list, e.g. claude-opus-5-5,claude-haiku-5-5
 *   LIVE_REPORT_DIR          where to write the JSON report (outside the repo)
 *
 * READ-ONLY BY CONSTRUCTION: the account provider is wrapped so any upstream
 * call that is not a body-less GET throws before it leaves the process. Write-
 * shaped requests (e.g. a Gmail send) are only ever evaluated by the rule
 * engine directly, never sent through the proxy.
 */
import { describe, expect, it, vi, beforeAll } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import Anthropic from '@anthropic-ai/sdk'
import { Hono } from 'hono'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as schema from '@shared/lib/db/schema'

const LIVE = process.env.PROXY_RULES_LIVE === '1'
let testDb: ReturnType<typeof drizzle>
let authorModel = 'claude-opus-5-5'
const forwarded: Array<{ method: string; url: string; status: number }> = []

vi.mock('@shared/lib/db', () => ({ get db() { return testDb } }))
vi.mock('@shared/lib/proxy/token-store', () => ({
  validateProxyToken: async (token: string) => (token.startsWith('token-') ? token.slice(6) : null),
}))
vi.mock('@shared/lib/services/user-settings-service', () => ({
  getUserSettings: async () => ({ defaultApiPolicy: 'review', defaultMcpPolicy: 'review' }),
}))
vi.mock('@shared/lib/container/message-persister', () => ({
  messagePersister: { syncAgentSessionsAwaiting: vi.fn() },
}))
vi.mock('@shared/lib/services/audit-log-service', () => ({ logAuditEvent: vi.fn() }))
vi.mock('@shared/lib/analytics/server-analytics', () => ({ trackServerEvent: vi.fn() }))
vi.mock('@shared/lib/platform-attribution', () => ({
  attribution: { fromResourceCreator: async () => ({}) },
  runWithAttribution: (_a: unknown, fn: () => unknown) => fn(),
}))
vi.mock('@shared/lib/services/platform-auth-service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getPlatformAccessToken: () => process.env.LIVE_PLATFORM_TOKEN ?? null,
}))
vi.mock('@shared/lib/config/settings', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getEffectiveComposioApiKey: () => null,
  getEffectiveModels: () => ({ agentModel: authorModel, summarizerModel: authorModel, browserModel: authorModel, dashboardBuilderModel: authorModel }),
}))
vi.mock('@shared/lib/llm-provider', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getActiveLlmProvider: () => ({
    id: 'anthropic',
    supportsDirectApi: true,
    getApiKeyStatus: () => ({ isConfigured: true }),
    createClient: () => new Anthropic({ apiKey: process.env.LIVE_ANTHROPIC_API_KEY }),
  }),
  resolveActiveProviderModel: (model: string) => model,
}))
// The read-only guard: wrap the real provider so nothing but a GET leaves.
vi.mock('@shared/lib/account-providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shared/lib/account-providers')>()
  return {
    ...actual,
    getAccountProviderByName: (name: string) => {
      const real = actual.getAccountProviderByName(name)
      return {
        getConnection: (...args: Parameters<typeof real.getConnection>) => real.getConnection(...args),
        makeApiCall: async (params: Parameters<typeof real.makeApiCall>[0]) => {
          if (params.method !== 'GET' || (params.body && params.body.byteLength > 0)) {
            throw new Error(`READ-ONLY GUARD: refused to forward ${params.method} ${params.targetUrl}`)
          }
          const response = await real.makeApiCall(params)
          forwarded.push({ method: params.method, url: params.targetUrl, status: response.status })
          return response
        },
      }
    },
  }
})

import proxy from '../../../../api/routes/proxy'
import { agentRegistry } from '@shared/lib/agent-actor'
import { userInputRequestManager } from '@shared/lib/tools/requests/request-manager'
import { authorRule, restateRule, type AuthorRuleRequest } from './author'
import { createRule, deleteRule, listRules } from './store'
import { buildApiRuleInput } from './input'
import { evaluateRules } from './engine'
import { toActiveRule } from './store'
import { RULE_HELPERS_SOURCE } from './helpers-source'
import vm from 'node:vm'
import { registerAccountProvider } from '@shared/lib/account-providers/provider-factory'
import { ComposioAccountProvider } from '@shared/lib/account-providers/composio-account-provider'

const accounts = JSON.parse(process.env.LIVE_ACCOUNTS ?? '{}') as {
  gmail?: string[]; googlecalendar?: string; slack?: string; github?: string
}
const reportDir = process.env.LIVE_REPORT_DIR ?? ''
const report: Record<string, unknown> = { startedAt: new Date().toISOString(), scenarios: [] as unknown[] }
const scenarios = report.scenarios as unknown[]
const AGENT = 'live-agent'
let app: Hono

function seedAccount(id: string, toolkit: string, connectionId: string, displayName: string) {
  const now = new Date()
  testDb.insert(schema.connectedAccounts).values({
    id, providerConnectionId: connectionId, providerName: 'composio', toolkitSlug: toolkit,
    displayName, status: 'active', createdAt: now, updatedAt: now,
  }).onConflictDoNothing().run()
  testDb.insert(schema.agentConnectedAccounts).values({
    id: `${AGENT}-${id}`, agentSlug: AGENT, connectedAccountId: id, createdAt: now,
  }).onConflictDoNothing().run()
}

type GetOutcome = { status: number; reviewed: boolean; forwarded: boolean; body: unknown }

/**
 * GET through the real proxy. If the request parks for review, the harness
 * decides: 'allow' for setup reads, 'deny' otherwise. Returns whether a
 * review happened and whether the request reached the upstream API.
 */
async function proxyGet(accountId: string, host: string, pathAndQuery: string, onReview: 'allow' | 'deny' = 'deny'): Promise<GetOutcome> {
  const before = forwarded.length
  let reviewed = false
  const pending = app.request(`/api/proxy/${AGENT}/${accountId}/${host}/${pathAndQuery.replace(/^\//, '')}`, {
    method: 'GET',
    headers: { Authorization: `Bearer token-${AGENT}` },
  })
  let settled = false
  const result = Promise.resolve(pending).then((r: Response) => { settled = true; return r })
  while (!settled) {
    const [review] = userInputRequestManager.getAgentScopedRequests(AGENT)
    if (review) {
      reviewed = true
      agentRegistry.get(AGENT).inputs.reviews.submit(review.id, onReview)
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  const response = await result
  let body: unknown = null
  try { body = await response.json() } catch { /* non-JSON */ }
  return { status: response.status, reviewed, forwarded: forwarded.length > before, body }
}

async function authorWithAnswers(request: AuthorRuleRequest, answers: string[]) {
  const clarifications: Array<{ question: string; answer: string }> = []
  const questions: string[] = []
  const started = Date.now()
  for (let round = 0; round < 4; round++) {
    const result = await authorRule({ ...request, clarifications })
    if (result.type === 'draft') return { result, questions, ms: Date.now() - started }
    questions.push(result.question)
    clarifications.push({ question: result.question, answer: answers[round] ?? 'Use the most conservative interpretation.' })
  }
  return { result: null, questions, ms: Date.now() - started }
}

async function saveDraft(accountId: string, draft: { description: string; patterns: string[]; code: string; tests: unknown[] }) {
  const { name, restatement } = await restateRule({ kind: 'api', effect: 'allow', patterns: draft.patterns, code: draft.code })
  const saved = await createRule({
    target: { kind: 'api', targetId: accountId },
    agentSlug: null,
    createdBy: 'user',
    createdByAgentSlug: null,
    version: { ...draft, tests: draft.tests as never, effect: 'allow', name, restatement, warnings: [], toolSchemaHash: null },
  })
  if (!saved) throw new Error('rule was not saved')
  return saved
}

async function clearRules(accountId: string) {
  for (const r of await listRules({ kind: 'api', targetId: accountId })) await deleteRule(r.rule.id)
}

function lastAudit() {
  const rows = testDb.select().from(schema.proxyAuditLog).all()
  return rows[rows.length - 1]
}

describe.skipIf(!LIVE)('proxy rules — live, read-only', () => {
  beforeAll(() => {
    registerAccountProvider(new ComposioAccountProvider())
    const sqlite = new Database(':memory:')
    testDb = drizzle(sqlite, { schema })
    migrate(testDb, { migrationsFolder: 'src/shared/lib/db/migrations' })
    app = new Hono()
    app.route('/api/proxy', proxy)
    if (reportDir) mkdirSync(reportDir, { recursive: true })
  })

  const models = (process.env.LIVE_AUTHOR_MODELS ?? 'claude-opus-5-5').split(',').map((m) => m.trim()).filter(Boolean)

  it('finds a Gmail account and its domain (setup reads approved)', async () => {
    const candidates = accounts.gmail ?? []
    const profiles: Array<{ id: string; domain: string | null; status: number }> = []
    for (const [i, connectionId] of candidates.entries()) {
      seedAccount(`gmail-${i}`, 'gmail', connectionId, `gmail-${i}`)
      const res = await proxyGet(`gmail-${i}`, 'gmail.googleapis.com', '/gmail/v1/users/me/profile', 'allow')
      const email = (res.body as { emailAddress?: string } | null)?.emailAddress ?? null
      profiles.push({ id: `gmail-${i}`, domain: email ? email.split('@')[1].toLowerCase() : null, status: res.status })
    }
    report.gmailProfiles = profiles
    expect(profiles.some((p) => p.status === 200)).toBe(true)
  }, 120_000)

  for (const model of models) {
    describe(`authored by ${model}`, () => {
      beforeAll(() => { authorModel = model })

      it('Gmail: metadata reads skip review, full bodies stay in review', async () => {
        const profiles = (report.gmailProfiles as Array<{ id: string; domain: string | null; status: number }>)
        const account = profiles.find((p) => p.status === 200)!
        await clearRules(account.id)
        const authored = await authorWithAnswers({
          kind: 'api', toolkit: 'gmail', targetName: `Gmail (${account.domain})`, existingRules: [],
          description: 'Let it read message headers (subject, from, to — format=metadata) without asking me, but reading full message bodies should still need my approval. Listing messages is fine too.',
        }, ['Yes — listing message ids is fine. Metadata only means format=metadata; anything else (full, raw, minimal, no format) needs approval.'])
        const scenario: Record<string, unknown> = { name: 'gmail-metadata', model, questions: authored.questions, authorMs: authored.ms }
        scenarios.push(scenario)
        expect(authored.result?.type).toBe('draft')
        const draft = authored.result!.type === 'draft' ? authored.result!.draft : null
        scenario.patterns = draft?.patterns
        scenario.validation = authored.result!.type === 'draft' ? { ok: authored.result!.report.ok, warnings: authored.result!.report.warnings, tests: authored.result!.report.testResults.length } : null
        const savedMeta = await saveDraft(account.id, draft!)
        scenario.code = draft?.code
        scenario.restatement = savedMeta.version.restatement

        const list = await proxyGet(account.id, 'gmail.googleapis.com', '/gmail/v1/users/me/messages?maxResults=3')
        const ids = ((list.body as { messages?: Array<{ id: string }> } | null)?.messages ?? []).map((m) => m.id)
        const listOutcome = { reviewed: list.reviewed, forwarded: list.forwarded, decision: lastAudit()?.policyDecision }
        let messageId = ids[0]
        if (!messageId) {
          // The rule kept listing in review; fetch an id with an approved setup read.
          const setup = await proxyGet(account.id, 'gmail.googleapis.com', '/gmail/v1/users/me/messages?maxResults=1', 'allow')
          messageId = ((setup.body as { messages?: Array<{ id: string }> } | null)?.messages ?? [])[0]?.id
        }
        const checks = {
          list: listOutcome,
          metadata: await proxyGet(account.id, 'gmail.googleapis.com', `/gmail/v1/users/me/messages/${messageId}?format=metadata&metadataHeaders=Subject`),
          full: await proxyGet(account.id, 'gmail.googleapis.com', `/gmail/v1/users/me/messages/${messageId}?format=full`),
          defaultFormat: await proxyGet(account.id, 'gmail.googleapis.com', `/gmail/v1/users/me/messages/${messageId}`),
          raw: await proxyGet(account.id, 'gmail.googleapis.com', `/gmail/v1/users/me/messages/${messageId}?format=raw`),
          caseTrick: await proxyGet(account.id, 'gmail.googleapis.com', `/gmail/v1/users/me/messages/${messageId}?format=METADATA`),
          duplicateParam: await proxyGet(account.id, 'gmail.googleapis.com', `/gmail/v1/users/me/messages/${messageId}?format=metadata&format=full`),
        }
        scenario.checks = Object.fromEntries(Object.entries(checks).map(([k, v]) => [k, 'status' in v ? { reviewed: v.reviewed, forwarded: v.forwarded, status: v.status } : v]))
        expect(checks.metadata.reviewed).toBe(false)
        expect(checks.metadata.forwarded).toBe(true)
        expect(checks.full.forwarded).toBe(false)
        expect(checks.defaultFormat.forwarded).toBe(false)
        expect(checks.raw.forwarded).toBe(false)
        expect(checks.duplicateParam.forwarded).toBe(false)
        await clearRules(account.id)
      }, 600_000)

      it('Calendar: primary calendar, at most 7 days ahead', async () => {
        if (!accounts.googlecalendar) return
        seedAccount('gcal', 'googlecalendar', accounts.googlecalendar, 'Google Calendar')
        await clearRules('gcal')
        const authored = await authorWithAnswers({
          kind: 'api', toolkit: 'googlecalendar', targetName: 'Google Calendar', existingRules: [],
          description: 'Let it read events on my primary calendar without asking, but only for the next 7 days.',
        }, [
          'Requests must set both timeMin and timeMax; the window must start no earlier than now minus 1 hour and end no later than now plus 7 days. Missing either means approval.',
          'Only the "primary" calendar id; not my email address as the id.',
        ])
        const scenario: Record<string, unknown> = { name: 'calendar-7-days', model, questions: authored.questions, authorMs: authored.ms }
        scenarios.push(scenario)
        expect(authored.result?.type).toBe('draft')
        const draft = authored.result!.type === 'draft' ? authored.result!.draft : null
        scenario.patterns = draft?.patterns
        scenario.validation = authored.result!.type === 'draft' ? { ok: authored.result!.report.ok, warnings: authored.result!.report.warnings } : null
        const savedCal = await saveDraft('gcal', draft!)
        scenario.code = draft?.code
        scenario.restatement = savedCal.version.restatement
        const now = Date.now()
        const iso = (ms: number) => encodeURIComponent(new Date(ms).toISOString())
        const day = 86_400_000
        const checks = {
          threeDays: await proxyGet('gcal', 'www.googleapis.com', `/calendar/v3/calendars/primary/events?timeMin=${iso(now)}&timeMax=${iso(now + 3 * day)}&maxResults=2`),
          thirtyDays: await proxyGet('gcal', 'www.googleapis.com', `/calendar/v3/calendars/primary/events?timeMin=${iso(now)}&timeMax=${iso(now + 30 * day)}&maxResults=2`),
          noWindow: await proxyGet('gcal', 'www.googleapis.com', '/calendar/v3/calendars/primary/events?maxResults=2'),
          pastYear: await proxyGet('gcal', 'www.googleapis.com', `/calendar/v3/calendars/primary/events?timeMin=${iso(now - 365 * day)}&timeMax=${iso(now)}&maxResults=2`),
          otherCalendar: await proxyGet('gcal', 'www.googleapis.com', `/calendar/v3/calendars/en.usa%23holiday%40group.v.calendar.google.com/events?timeMin=${iso(now)}&timeMax=${iso(now + 3 * day)}&maxResults=2`),
        }
        scenario.checks = Object.fromEntries(Object.entries(checks).map(([k, v]) => [k, { reviewed: v.reviewed, forwarded: v.forwarded, status: v.status }]))
        expect(checks.threeDays.forwarded).toBe(true)
        expect(checks.threeDays.reviewed).toBe(false)
        expect(checks.thirtyDays.forwarded).toBe(false)
        expect(checks.noWindow.forwarded).toBe(false)
        expect(checks.pastYear.forwarded).toBe(false)
        expect(checks.otherCalendar.forwarded).toBe(false)
        await clearRules('gcal')
      }, 600_000)

      it('Slack: list public channels only', async () => {
        if (!accounts.slack) return
        seedAccount('slack', 'slack', accounts.slack, 'Slack')
        await clearRules('slack')
        const authored = await authorWithAnswers({
          kind: 'api', toolkit: 'slack', targetName: 'Slack', existingRules: [],
          description: 'Let it list channels without asking, but only public channels — never private channels or DMs.',
        }, ['Only conversations.list. Treat a missing types parameter the way Slack does.'])
        const scenario: Record<string, unknown> = { name: 'slack-public-channels', model, questions: authored.questions, authorMs: authored.ms }
        scenarios.push(scenario)
        expect(authored.result?.type).toBe('draft')
        const draft = authored.result!.type === 'draft' ? authored.result!.draft : null
        scenario.patterns = draft?.patterns
        scenario.code = draft?.code
        const savedSlack = await saveDraft('slack', draft!)
        scenario.restatement = savedSlack.version.restatement
        const checks = {
          publicOnly: await proxyGet('slack', 'slack.com', '/api/conversations.list?types=public_channel&limit=2'),
          noTypes: await proxyGet('slack', 'slack.com', '/api/conversations.list?limit=2'),
          withPrivate: await proxyGet('slack', 'slack.com', '/api/conversations.list?types=public_channel,private_channel&limit=2'),
          dms: await proxyGet('slack', 'slack.com', '/api/conversations.list?types=im&limit=2'),
          history: await proxyGet('slack', 'slack.com', '/api/conversations.history?channel=C000&limit=1'),
        }
        scenario.checks = Object.fromEntries(Object.entries(checks).map(([k, v]) => [k, { reviewed: v.reviewed, forwarded: v.forwarded, status: v.status }]))
        expect(checks.publicOnly.forwarded).toBe(true)
        expect(checks.withPrivate.forwarded).toBe(false)
        expect(checks.dms.forwarded).toBe(false)
        expect(checks.history.forwarded).toBe(false)
        await clearRules('slack')
      }, 600_000)

      it('Gmail send rule (engine only): real recipient headers from the mailbox', async () => {
        const profiles = (report.gmailProfiles as Array<{ id: string; domain: string | null; status: number }>)
        const account = profiles.find((p) => p.status === 200 && p.domain)!
        const authored = await authorWithAnswers({
          kind: 'api', toolkit: 'gmail', targetName: `Gmail (${account.domain})`, existingRules: [],
          description: 'Let it send email without asking when every recipient is internal.',
        }, [`Internal means exactly @${account.domain}; subdomains do not count. Cover sending drafts too only if the recipients are visible in the request; otherwise leave them in review.`])
        const scenario: Record<string, unknown> = { name: 'gmail-internal-send', model, questions: authored.questions, authorMs: authored.ms }
        scenarios.push(scenario)
        expect(authored.result?.type).toBe('draft')
        const draft = authored.result!.type === 'draft' ? authored.result!.draft : null
        const authoredReport = authored.result!.type === 'draft' ? authored.result!.report : null
        scenario.patterns = draft?.patterns
        scenario.code = draft?.code
        scenario.validation = authoredReport ? { ok: authoredReport.ok, warnings: authoredReport.warnings, tests: authoredReport.testResults.length, failed: authoredReport.testResults.filter((t) => !t.passed).map((t) => t.name) } : null
        scenario.restatement = draft ? (await restateRule({ kind: 'api', effect: draft.effect, patterns: draft.patterns, code: draft.code })).restatement : null

        // Pull real messages (read-only, setup reads approved) and replay their
        // recipient headers as messages.send bodies through the engine only.
        const listing = await proxyGet(account.id, 'gmail.googleapis.com', '/gmail/v1/users/me/messages?maxResults=40&q=in:sent OR in:inbox', 'allow')
        const ids = ((listing.body as { messages?: Array<{ id: string }> } | null)?.messages ?? []).map((m) => m.id)
        const rule = toActiveRule({
          rule: { id: 'live', kind: 'api' } as never,
          version: { id: 'live-v1', version: 1, effect: 'allow', name: '', restatement: '', patterns: JSON.stringify(draft!.patterns), code: draft!.code, toolSchemaHash: null } as never,
        })
        const helpers = vm.runInNewContext(RULE_HELPERS_SOURCE) as { recipients(raw: string): Array<{ domain: string; address: string }> | null }
        const samples: Array<{ id: string; headers: Record<string, string[]>; helper: string[] | null; ruleAllowed: boolean }> = []
        for (const id of ids) {
          const res = await proxyGet(account.id, 'gmail.googleapis.com', `/gmail/v1/users/me/messages/${id}?format=raw`, 'allow')
          const raw = (res.body as { raw?: string } | null)?.raw
          if (!raw) continue
          const text = Buffer.from(raw, 'base64url').toString('utf8')
          const headerBlock = text.split(/\r?\n\r?\n/)[0]
          const headers: Record<string, string[]> = {}
          for (const line of headerBlock.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
            const m = /^(to|cc|bcc|resent-to|resent-cc|resent-bcc)\s*:\s*(.*)$/i.exec(line)
            if (m) (headers[m[1].toLowerCase()] ??= []).push(m[2])
          }
          // Build a send request carrying only the recipient headers (no body).
          const sendMessage = Object.entries(headers).flatMap(([k, vs]) => vs.map((v) => `${k}: ${v}`)).join('\r\n') + '\r\nSubject: replay\r\n\r\n(no body)'
          const input = buildApiRuleInput({
            method: 'POST', host: 'gmail.googleapis.com', path: '/gmail/v1/users/me/messages/send', search: '',
            headers: new Headers({ 'content-type': 'application/json' }),
            body: new TextEncoder().encode(JSON.stringify({ raw: Buffer.from(sendMessage).toString('base64url') })).buffer as ArrayBuffer,
          })
          const outcome = await evaluateRules([rule], input, 'review')
          const parsed = helpers.recipients(sendMessage)
          samples.push({ id, headers, helper: parsed ? parsed.map((a) => a.address) : null, ruleAllowed: outcome.allowedBy !== null })
        }
        if (reportDir) writeFileSync(path.join(reportDir, `gmail-recipient-samples-${model}.json`), JSON.stringify({ domain: account.domain, samples }, null, 2))
        scenario.samples = {
          total: samples.length,
          allowed: samples.filter((s) => s.ruleAllowed).length,
          helperNull: samples.filter((s) => s.helper === null).length,
        }
        // Allowed only when every parsed address is on the domain.
        for (const s of samples.filter((x) => x.ruleAllowed)) {
          expect(s.helper?.length).toBeGreaterThan(0)
          expect(s.helper!.every((a) => a.toLowerCase().endsWith(`@${account.domain}`))).toBe(true)
        }
      }, 900_000)
    })
  }

  it('address parser vs real headers across every Gmail account (metadata reads)', async () => {
    if (process.env.LIVE_PARSER_SAMPLE !== '1') return
    const profiles = (report.gmailProfiles as Array<{ id: string; domain: string | null; status: number }>).filter((p) => p.status === 200)
    const helpers = vm.runInNewContext(RULE_HELPERS_SOURCE) as { parseAddressList(v: string): Array<{ address: string }> | null }
    const samples: Array<{ header: string; value: string; helper: string[] | null }> = []
    let formatProbe: Record<string, unknown> | null = null
    for (const profile of profiles) {
      const listing = await proxyGet(profile.id, 'gmail.googleapis.com', '/gmail/v1/users/me/messages?maxResults=100', 'allow')
      const ids = ((listing.body as { messages?: Array<{ id: string }> } | null)?.messages ?? []).map((m) => m.id)
      for (const id of ids) {
        const res = await proxyGet(profile.id, 'gmail.googleapis.com',
          `/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=From&metadataHeaders=Reply-To`, 'allow')
        const headers = ((res.body as { payload?: { headers?: Array<{ name: string; value: string }> } } | null)?.payload?.headers) ?? []
        for (const h of headers) {
          const parsed = helpers.parseAddressList(h.value)
          samples.push({ header: h.name.toLowerCase(), value: h.value, helper: parsed ? parsed.map((a) => a.address) : null })
        }
        if (!formatProbe) {
          // Does Gmail read format=METADATA (uppercase) as metadata or as full?
          const upper = await proxyGet(profile.id, 'gmail.googleapis.com', `/gmail/v1/users/me/messages/${id}?format=METADATA`, 'allow')
          const lower = await proxyGet(profile.id, 'gmail.googleapis.com', `/gmail/v1/users/me/messages/${id}?format=metadata`, 'allow')
          const shape = (b: unknown) => {
            const payload = (b as { payload?: { body?: { data?: string; size?: number }; parts?: unknown[] } } | null)?.payload
            return { hasBody: !!b, hasBodyData: !!payload?.body?.data, partCount: payload?.parts?.length ?? 0, bodySize: payload?.body?.size ?? null }
          }
          formatProbe = { upper: { status: upper.status, ...shape(upper.body) }, lower: { status: lower.status, ...shape(lower.body) } }
        }
      }
    }
    report.formatProbe = formatProbe
    if (reportDir) writeFileSync(path.join(reportDir, 'header-samples.json'), JSON.stringify(samples, null, 2))
    report.headerSamples = { total: samples.length, helperNull: samples.filter((s) => s.helper === null).length }
  }, 900_000)

  it('restatement flags a vacuous rule', async () => {
    authorModel = models[0]
    const { restatement } = await restateRule({
      kind: 'api',
      effect: 'allow',
      patterns: ['POST /gmail/v1/users/*/messages/send'],
      code: `(req, h) => (h.recipients(h.decodeBase64(req.body && req.body.raw) || '') || []).every((a) => h.domainMatches(a.domain, 'acme.com'))`,
    })
    scenarios.push({ name: 'restatement-vacuous', restatement })
    expect(restatement.length).toBeGreaterThan(0)
  }, 120_000)

  it('never forwarded anything but GET', () => {
    report.forwarded = forwarded.map((f) => ({ method: f.method, host: new URL(f.url).host, path: new URL(f.url).pathname.replace(/\/[A-Za-z0-9_-]{12,}$/, '/<id>'), status: f.status }))
    report.finishedAt = new Date().toISOString()
    if (reportDir) writeFileSync(path.join(reportDir, 'report.json'), JSON.stringify(report, null, 2))
    expect(forwarded.every((f) => f.method === 'GET')).toBe(true)
  })
})
