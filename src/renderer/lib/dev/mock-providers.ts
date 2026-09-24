import { CLAUDE_BARE_CATALOG, PLATFORM_CATALOG } from '@shared/lib/llm-provider/builtin-catalogs'
import type { ConnectionInfo } from '@shared/lib/llm-provider/connection-schema'
import type { ModelDefinition } from '@shared/lib/llm-provider/model-catalog-schema'
import type { LlmProviderId } from '@shared/lib/llm-provider/provider-types'
import type { ProviderUsage, UsageLimit } from '@shared/lib/llm-provider/usage-schema'

/**
 * Dev-only mock provider connections, for building the model picker's provider
 * dropdown (SUP-905) without real Claude / Codex / Grok / Platform accounts.
 *
 * Off by default. When a scenario is set, `apiFetch` appends the mock
 * connections to every connection list the pickers and settings read, and
 * answers their `/usage` reads from the fixtures below. The mocks are
 * display-only: any write that names a mock connection is refused before it
 * reaches the server, so nothing is persisted against a fake id.
 *
 * Turn on with the "Mock providers" pill at the top of the window (dev builds),
 * `mockProviders('warning')` in DevTools, or `?mockProviders=warning` in the URL.
 */

export const MOCK_PROVIDER_SCENARIOS = {
  healthy: 'Healthy — low usage everywhere',
  warning: 'Warning — 82–91% used',
  exhausted: 'Exhausted — 100%+ and zero balances',
  mixed: 'Mixed — extra windows, no seat, missing balance',
  unavailable: 'Unavailable — usage reads fail (no bars)',
  slow: 'Slow — healthy data after a 2.5s delay',
} as const
export type MockProviderScenario = keyof typeof MOCK_PROVIDER_SCENARIOS

const STORAGE_KEY = 'superagent.dev.mockProviders'
export const MOCK_PROVIDERS_EVENT = 'superagent:mock-providers'
const MOCK_ID_PREFIX = 'dev-mock-'

function isScenario(value: unknown): value is MockProviderScenario {
  return typeof value === 'string' && Object.hasOwn(MOCK_PROVIDER_SCENARIOS, value)
}

export function getMockScenario(): MockProviderScenario | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    return isScenario(value) ? value : null
  } catch {
    return null
  }
}

export function setMockScenario(scenario: MockProviderScenario | null): void {
  try {
    if (scenario) localStorage.setItem(STORAGE_KEY, scenario)
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Storage unavailable: the mock simply stays off.
  }
  window.dispatchEvent(new CustomEvent(MOCK_PROVIDERS_EVENT, { detail: getMockScenario() }))
}

/** Accept `?mockProviders=<scenario|off>` once, so web dev can link straight into a state. */
export function readMockScenarioFromUrl(): void {
  const value = new URLSearchParams(window.location.search).get('mockProviders')
  if (value === 'off') setMockScenario(null)
  else if (isScenario(value)) setMockScenario(value)
}

// ---------------------------------------------------------------------------
// Connections

function catalogDefault(catalog: ModelDefinition[]): string | null {
  return catalog.find(m => m.isDefault)?.id ?? catalog[0]?.id ?? null
}

function mockConnection(key: string, name: string, provider: LlmProviderId, catalog: ModelDefinition[],
  extra: Partial<ConnectionInfo> = {}): ConnectionInfo {
  return {
    id: `${MOCK_ID_PREFIX}${key}`,
    name,
    provider,
    userId: null,
    ownerName: null,
    managed: false,
    isConfigured: true,
    supportsUsage: true,
    catalog,
    modelOverrides: [],
    defaultModel: catalogDefault(catalog),
    browserModel: null,
    dashboardModel: null,
    canManage: false,
    canDelete: false,
    deletionBlockedReason: 'Dev mock connection',
    ...extra,
  }
}

// Mirrors the subscription providers' getBuiltinCatalog() filters.
const codexCatalog = PLATFORM_CATALOG.filter(m => m.family === 'gpt')
const grokCatalog = PLATFORM_CATALOG.filter(m => m.family === 'grok')

const MOCK_CONNECTIONS: ConnectionInfo[] = [
  // Claude subscriptions report no usage, so this row never shows bars.
  mockConnection('claude', 'Claude Subscription', 'claude-subscription', CLAUDE_BARE_CATALOG, { supportsUsage: false, accountLabel: 'dev@example.com' }),
  // Agent-only: disabled in direct-API pickers (summarizer, browser).
  mockConnection('codex', 'Codex Subscription', 'codex-subscription', codexCatalog, { supportsDirectApi: false }),
  mockConnection('grok', 'Grok Subscription', 'grok-subscription', grokCatalog),
  mockConnection('platform', 'Gamut Platform', 'platform', PLATFORM_CATALOG, { managed: true }),
]

// ---------------------------------------------------------------------------
// Usage fixtures

const inHours = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString()
const window_ = (id: string, label: string, usedPercent: number, resetsInHours?: number): UsageLimit =>
  ({ kind: 'window', id, label, usedPercent, ...(resetsInHours === undefined ? {} : { resetsAt: inHours(resetsInHours) }) })
const balance = (id: string, label: string, remaining: number, unit: 'USD' | 'credits' = 'USD'): UsageLimit =>
  ({ kind: 'balance', id, label, remaining, unit })

type UsageFixtures = Record<'codex' | 'grok' | 'platform', UsageLimit[]>

const HEALTHY: UsageFixtures = {
  codex: [window_('codex-primary', '5h', 14, 3.2), window_('codex-secondary', 'Weekly', 31, 96), balance('credits', 'Credits', 250, 'credits')],
  grok: [window_('included', 'Monthly', 22, 430), balance('prepaid', 'Prepaid credits', 18.4)],
  platform: [window_('seat', 'Seat allowance', 9, 510), balance('seat-credits', 'Seat credits', 45.5), balance('organization-credits', 'Organization credits', 1240)],
}

const USAGE: Record<Exclude<MockProviderScenario, 'unavailable' | 'slow'>, UsageFixtures> = {
  healthy: HEALTHY,
  warning: {
    codex: [window_('codex-primary', '5h', 86, 1.1), window_('codex-secondary', 'Weekly', 64, 70), balance('credits', 'Credits', 12, 'credits')],
    grok: [window_('included', 'Monthly', 91, 120), balance('prepaid', 'Prepaid credits', 2.1)],
    platform: [window_('seat', 'Seat allowance', 82, 200), balance('seat-credits', 'Seat credits', 9), balance('organization-credits', 'Organization credits', 310)],
  },
  exhausted: {
    // Upstreams can report past 100%; the bar clamps, the label does not.
    codex: [window_('codex-primary', '5h', 104, 0.4), window_('codex-secondary', 'Weekly', 97, 30), balance('credits', 'Credits', 0, 'credits')],
    grok: [window_('included', 'Monthly', 100, 48), balance('prepaid', 'Prepaid credits', 0)],
    platform: [window_('seat', 'Seat allowance', 100, 72), balance('seat-credits', 'Seat credits', 0), balance('organization-credits', 'Organization credits', 0)],
  },
  mixed: {
    // Codex with review + additional buckets; Grok with no prepaid balance
    // reported (missing ≠ zero); Platform member without a seat.
    codex: [
      window_('codex-primary', '5h', 38, 2.5), window_('codex-secondary', 'Weekly', 71, 60),
      window_('review-primary', 'Code review · Weekly', 12, 60), window_('additional-0-primary', 'GPT-6 Astra · 5h', 96, 0.8),
      balance('credits', 'Credits', 1250.75, 'credits'),
    ],
    grok: [window_('included', 'Monthly', 83, 300)],
    platform: [balance('organization-credits', 'Organization credits', 86.2)],
  },
}

async function mockUsageResponse(scenario: MockProviderScenario, key: string): Promise<Response> {
  if (scenario === 'unavailable') return json({ error: 'Usage unavailable' }, 500)
  if (scenario === 'slow') await new Promise(resolve => setTimeout(resolve, 2500))
  const limits = (scenario === 'slow' ? HEALTHY : USAGE[scenario])[key as keyof UsageFixtures]
  if (!limits) return json({ status: 'unsupported', observedAt: new Date().toISOString(), limits: [] } satisfies ProviderUsage)
  return json({ status: 'available', observedAt: new Date().toISOString(), limits } satisfies ProviderUsage)
}

// ---------------------------------------------------------------------------
// apiFetch interception

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const CONNECTION_LISTS = [
  /^\/api\/llm-connections$/,
  /^\/api\/settings\/models$/,
  /^\/api\/agents\/[^/]+\/llm-connections$/,
  /^\/api\/agents\/[^/]+\/sessions\/[^/]+\/llm-connections$/,
]
const USAGE_PATH = new RegExp(`^/api/llm-connections/${MOCK_ID_PREFIX}([^/]+)/usage$`)

/**
 * Returns a mocked response, or null to let the request through untouched.
 * `realFetch` performs the original request (used to augment connection lists).
 */
export async function mockProviderFetch(path: string, init: RequestInit | undefined,
  realFetch: () => Promise<Response>): Promise<Response | null> {
  const scenario = getMockScenario()
  if (!scenario) return null
  const [pathname] = path.split('?')
  const method = (init?.method ?? 'GET').toUpperCase()

  if (method !== 'GET') {
    const body = typeof init?.body === 'string' ? init.body : ''
    if (pathname.includes(`/${MOCK_ID_PREFIX}`) || body.includes(`"${MOCK_ID_PREFIX}`)) {
      console.warn('[mock-providers] Refused a write naming a mock connection:', method, path)
      return json({ error: 'Mock provider connections are display-only. Pick a real connection or turn mocks off.' }, 409)
    }
    return null
  }

  const usage = USAGE_PATH.exec(pathname)
  if (usage) return mockUsageResponse(scenario, usage[1])

  if (!CONNECTION_LISTS.some(re => re.test(pathname))) return null
  const response = await realFetch()
  if (!response.ok) return response
  const data: { connections?: ConnectionInfo[] } = await response.json()
  if (Array.isArray(data.connections)) data.connections = [...data.connections, ...MOCK_CONNECTIONS]
  return json(data, response.status)
}
