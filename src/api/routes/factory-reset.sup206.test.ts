import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { is, Table, getTableName } from 'drizzle-orm'
import * as schema from '@shared/lib/db/schema'

// ---------------------------------------------------------------------------
// SUP-206 — POST /api/settings/factory-reset must clear EVERY agent/app-owned
// relational table, not just the historical subset of 8. We mock @shared/lib/db
// so db.delete is a spy that records the table object it received, but we import
// the REAL schema so the recorded objects can be matched by identity against the
// full set of tables. The expected set is derived dynamically from the schema
// (all Drizzle tables minus the Better Auth set), so it can never drift: adding
// a new agent/app-owned table without wiring it into factory-reset fails here.
// ---------------------------------------------------------------------------

// Names prefixed with `mock` so vitest's vi.mock hoisting allows referencing it.
const mockDeletedTables: unknown[] = []

vi.mock('@shared/lib/db', () => ({
  db: {
    delete: (t: unknown) => {
      mockDeletedTables.push(t)
      return { run: () => undefined, where: () => ({ run: () => undefined }) }
    },
  },
}))

// IMPORTANT: do NOT mock '@shared/lib/db/schema' — we use the real table objects.

// --- Heavy deps the route pulls in at import time / during factory-reset ----

const mockClearSettingsCache = vi.fn()

vi.mock('@shared/lib/config/settings', () => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  clearSettingsCache: (...args: unknown[]) => mockClearSettingsCache(...args),
  getBrowserbaseApiKeyStatus: vi.fn(),
  getComposioApiKeyStatus: vi.fn(),
  getNangoApiKeyStatus: vi.fn(),
  getComposioUserId: vi.fn(),
  getAccountProviderUserId: vi.fn(),
  getVoiceSettings: vi.fn(),
  getEffectiveModels: vi.fn(),
  getEffectiveAgentLimits: vi.fn(),
  getCustomEnvVars: vi.fn(),
}))

const mockStopAll = vi.fn().mockResolvedValue(undefined)

vi.mock('@shared/lib/container/container-manager', () => ({
  containerManager: {
    hasRunningAgents: vi.fn().mockReturnValue(false),
    getRunningAgentIds: vi.fn().mockResolvedValue([]),
    clearClients: vi.fn(),
    ensureImageReady: vi.fn().mockResolvedValue(undefined),
    getReadiness: vi.fn().mockReturnValue({ ready: true }),
    stopAll: (...args: unknown[]) => mockStopAll(...args),
  },
}))

vi.mock('@shared/lib/container/client-factory', () => ({
  checkAllRunnersAvailability: vi.fn().mockResolvedValue([]),
  refreshRunnerAvailability: vi.fn().mockResolvedValue([]),
  startRunner: vi.fn(),
  restartRunner: vi.fn(),
  SUPPORTED_RUNNERS: ['docker', 'podman'],
}))

vi.mock('@shared/lib/config/data-dir', () => ({
  getDataDir: () => '/mock/data',
  getAgentsDataDir: () => '/mock/data/agents',
}))

vi.mock('../../main/host-browser', () => ({
  detectAllProviders: () => [],
}))

vi.mock('@shared/lib/stt', () => ({
  getSttProvider: () => ({
    getApiKeyStatus: () => ({ isConfigured: false, source: 'none' }),
    validateKey: vi.fn(),
  }),
}))

// Auth middleware: no-op in tests (non-auth mode)
vi.mock('../middleware/auth', () => ({
  Authenticated: () => async (_c: unknown, next: () => Promise<void>) => next(),
  IsAdmin: () => async (_c: unknown, next: () => Promise<void>) => next(),
}))

vi.mock('@shared/lib/auth/mode', () => ({
  isAuthMode: () => false,
}))

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn(),
}))

const mockRevokePlatformToken = vi.fn().mockResolvedValue(true)

vi.mock('@shared/lib/services/platform-auth-service', () => ({
  revokePlatformToken: (...args: unknown[]) => mockRevokePlatformToken(...args),
}))

vi.mock('fs', () => ({
  default: { promises: { rm: vi.fn().mockResolvedValue(undefined) } },
}))

vi.mock('@shared/lib/analytics/tenant-id', () => ({
  getTenantId: () => 'mock-tenant-id',
}))

vi.mock('path', () => ({
  default: { join: (...args: string[]) => args.join('/') },
}))

import settings from './settings'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createApp() {
  const app = new Hono()
  app.route('/api/settings', settings)
  return app
}

// Better Auth tables are intentionally NOT wiped by factory reset.
const BETTER_AUTH_TABLES = new Set<unknown>([
  schema.user,
  schema.authSession,
  schema.authAccount,
  schema.verification,
])

/** Every Drizzle table defined in the schema (by object identity). */
function allSchemaTables(): unknown[] {
  return Object.values(schema).filter((v) => is(v, Table))
}

/** Agent/app-owned relational tables that factory reset MUST clear. */
function agentOwnedTables(): unknown[] {
  return allSchemaTables().filter((t) => !BETTER_AUTH_TABLES.has(t))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/settings/factory-reset — agent/app-owned table cleanup', () => {
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    vi.clearAllMocks()
    mockDeletedTables.length = 0
    app = createApp()
  })

  async function factoryReset(): Promise<Response> {
    return app.request('http://localhost/api/settings/factory-reset', {
      method: 'POST',
    })
  }

  it('returns 200 and stops containers + clears settings cache', async () => {
    const res = await factoryReset()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true })
    expect(mockStopAll).toHaveBeenCalledOnce()
    expect(mockClearSettingsCache).toHaveBeenCalledOnce()
  })

  it('clears all agent-owned relational data (every non-Better-Auth table)', async () => {
    const res = await factoryReset()
    expect(res.status).toBe(200)

    // Sanity: the schema actually has the agent/app-owned tables we expect.
    const expectedTables = agentOwnedTables()
    expect(expectedTables.length).toBeGreaterThanOrEqual(19)

    // Every agent/app-owned table must have been passed to db.delete().
    for (const table of expectedTables) {
      expect(
        mockDeletedTables,
        `factory-reset must delete agent/app-owned table "${getTableName(table as Table)}"`,
      ).toContain(table)
    }
  })

  it('does NOT delete Better Auth tables (user accounts survive a factory reset)', async () => {
    const res = await factoryReset()
    expect(res.status).toBe(200)

    for (const table of BETTER_AUTH_TABLES) {
      expect(
        mockDeletedTables,
        `factory-reset must NOT delete Better Auth table "${getTableName(table as Table)}"`,
      ).not.toContain(table)
    }
  })
})
