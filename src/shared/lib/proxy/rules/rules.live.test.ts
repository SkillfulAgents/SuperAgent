/**
 * Live validation of proxy rules against real connected accounts.
 *
 * Gated: PROXY_RULES_LIVE=1. Needs
 *   LIVE_PLATFORM_TOKEN      platform access token (Composio via the platform proxy)
 *   PLATFORM_PROXY_URL       e.g. https://platformproxy.gamutagents.com
 *   LIVE_ANTHROPIC_API_KEY   for restatements
 *   LIVE_ACCOUNTS            JSON { gmail: [ca_…] }
 *   LIVE_AUTHOR_MODELS       comma list; the first writes restatements
 *   LIVE_REPORT_DIR          where to write the JSON report (outside the repo)
 *
 * READ-ONLY BY CONSTRUCTION: the account provider is wrapped so any upstream
 * call that is not a body-less GET throws before it leaves the process.
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
import { restateRule } from './author'
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
