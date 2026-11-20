import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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
// What the reset did to agents and tables, in order.
const mockSteps: string[] = []

vi.mock('@shared/lib/db', () => ({
  db: {
    delete: (t: unknown) => {
      mockDeletedTables.push(t)
      mockSteps.push('clear table')
      return { run: () => undefined, where: () => ({ run: () => undefined }) }
    },
  },
}))

// IMPORTANT: do NOT mock '@shared/lib/db/schema' — we use the real table objects.

// --- Heavy deps the route pulls in at import time / during factory-reset ----

const mockDeletedRecords: string[] = []

vi.mock('@shared/lib/app-records/records', () => ({
  deleteRecord: async (key: string) => { mockDeletedRecords.push(key) },
}))

vi.mock('@shared/lib/config/settings', () => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
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

vi.mock('@shared/lib/container/container-host', async () => {
  const { hostFromManagerMock } = await import('@shared/lib/agent-actor/testing/host-from-manager-mock')
  return {
    containerHost: hostFromManagerMock({
      hasRunningAgents: vi.fn().mockReturnValue(false),
      getRunningAgentIds: vi.fn().mockResolvedValue([]),
      clearClients: vi.fn(),
      ensureImageReady: vi.fn().mockResolvedValue(undefined),
      getReadiness: vi.fn().mockReturnValue({ ready: true }),
      stopAll: (...args: unknown[]) => mockStopAll(...args),
    }),
  }
})

// The agent layer: the catalog lists the agents, and each actor reports and
// stops its own container (none of them is held by this process's host).
type MockActor = { container: { status: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> } }
const mockActors = new Map<string, MockActor>()

vi.mock('@shared/lib/agent-actor/agent-catalog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@shared/lib/agent-actor/agent-catalog')>()),
  agentCatalog: { list: async () => [...mockActors.keys()] },
}))

vi.mock('@shared/lib/agent-actor/registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@shared/lib/agent-actor/registry')>()),
  agentRegistry: { get: (slug: string) => mockActors.get(slug) },
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

vi.mock('@shared/lib/voice', () => ({
  getVoiceProvider: () => ({
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

const mockRm = vi.fn()

vi.mock('fs', () => ({
  default: { promises: { rm: (...args: unknown[]) => mockRm(...args) } },
}))

vi.mock('@shared/lib/analytics/tenant-id', () => ({
  getTenantId: () => 'mock-tenant-id',
}))

vi.mock('path', () => ({
  default: { join: (...args: string[]) => args.join('/') },
}))

import settings from './settings'
import { setWorkspaceRemoval } from '@shared/lib/agent-actor/workspace-removal'

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

// The data-migration ledger survives too: it says which one-time moves this
// database has been through, and a reset database is empty, not legacy. App
// records are cleared key by key: settings go, the tenant id and the auth
// secret (which user accounts depend on) stay.
const PRESERVED_TABLES = new Set<unknown>([...BETTER_AUTH_TABLES, schema.dataMigrations, schema.appRecords])

/** Every Drizzle table defined in the schema (by object identity). */
function allSchemaTables(): unknown[] {
  return Object.values(schema).filter((v) => is(v, Table))
}

/** Agent/app-owned relational tables that factory reset MUST clear. */
function agentOwnedTables(): unknown[] {
  return allSchemaTables().filter((t) => !PRESERVED_TABLES.has(t))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/settings/factory-reset — agent/app-owned table cleanup', () => {
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    vi.clearAllMocks()
    mockDeletedTables.length = 0
    mockDeletedRecords.length = 0
    app = createApp()
  })

  async function factoryReset(): Promise<Response> {
    return app.request('http://localhost/api/settings/factory-reset', {
      method: 'POST',
    })
  }

  it('returns 200, stops containers, and deletes the settings and device identity records', async () => {
    const res = await factoryReset()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true })
    expect(mockStopAll).toHaveBeenCalledOnce()
    expect(mockDeletedRecords.sort()).toEqual(['platform-client-instance-id', 'settings'])
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

  it('keeps the data-migration ledger, so a reset database does not re-run one-time moves', async () => {
    const res = await factoryReset()
    expect(res.status).toBe(200)
    expect(mockDeletedTables).not.toContain(schema.dataMigrations)
  })
})

describe('POST /api/settings/factory-reset — agents reached through the agent layer', () => {
  let app: ReturnType<typeof createApp>

  function addAgent(slug: string, status: 'running' | 'stopped'): MockActor {
    const actor: MockActor = {
      container: {
        status: vi.fn(async () => ({ status, port: null })),
        stop: vi.fn(async () => { mockSteps.push(`stop ${slug}`) }),
      },
    }
    mockActors.set(slug, actor)
    return actor
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockRm.mockResolvedValue(undefined)
    mockSteps.length = 0
    mockActors.clear()
    // The deployment's own removal: from here on no workspace directory is touched.
    setWorkspaceRemoval(async (slug) => { mockSteps.push(`remove ${slug}`) })
    app = createApp()
  })

  afterEach(() => {
    setWorkspaceRemoval(null)
    mockActors.clear()
  })

  async function factoryReset(): Promise<Response> {
    return app.request('http://localhost/api/settings/factory-reset', { method: 'POST' })
  }

  it('stops each running agent through its actor, for deletion', async () => {
    const research = addAgent('research-agent', 'running')
    const writer = addAgent('writer-agent', 'stopped')
    const support = addAgent('support-agent', 'running')

    const res = await factoryReset()

    expect(res.status).toBe(200)
    expect(research.container.stop).toHaveBeenCalledWith({ forDeletion: true })
    expect(support.container.stop).toHaveBeenCalledWith({ forDeletion: true })
    expect(writer.container.stop).not.toHaveBeenCalled()
  })

  it('removes every workspace through the removal after the stops and before the tables, touching no agent directory', async () => {
    addAgent('research-agent', 'running')
    addAgent('writer-agent', 'stopped')

    const res = await factoryReset()

    expect(res.status).toBe(200)
    const removals = mockSteps.filter((step) => step.startsWith('remove '))
    expect(removals.sort()).toEqual(['remove research-agent', 'remove writer-agent'])
    const lastStop = mockSteps.lastIndexOf('stop research-agent')
    const firstRemoval = mockSteps.findIndex((step) => step.startsWith('remove '))
    const lastRemoval = mockSteps.findLastIndex((step) => step.startsWith('remove '))
    expect(lastStop).toBeLessThan(firstRemoval)
    expect(lastRemoval).toBeLessThan(mockSteps.indexOf('clear table'))
    expect(mockRm.mock.calls.map(([target]) => target)).toEqual([
      '/mock/data/agents',
      '/mock/data/settings.json',
      '/mock/data/.platform-auth',
    ])
  })

  it('treats a missing agents directory as already removed', async () => {
    addAgent('research-agent', 'running')
    mockRm.mockRejectedValue(Object.assign(new Error("no such file or directory, rm 'agents'"), { code: 'ENOENT' }))

    const res = await factoryReset()

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true })
    expect(mockSteps).toContain('clear table')
  })

  it('still fails when the agents directory cannot be removed for another reason', async () => {
    mockRm.mockRejectedValueOnce(Object.assign(new Error('permission denied'), { code: 'EACCES' }))

    const res = await factoryReset()

    expect(res.status).toBe(500)
    expect(mockSteps).not.toContain('clear table')
  })
})
