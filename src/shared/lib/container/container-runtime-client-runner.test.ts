vi.mock('@shared/lib/account-providers/provider-factory', () => ({
  getDefaultAccountProvider: async () => ({ name: 'composio' }),
}))
vi.mock('@shared/lib/agent-integrations/mcp', () => ({ integrationMcpProjection: vi.fn(async () => []) }))
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ContainerRunner } from './types'

// ============================================================================
// Mocks — must be set up before importing container-host
// ============================================================================

/** Every client the runtime built, with the runner it was built for. */
const built: Array<{ runner: ContainerRunner; client: { stop: ReturnType<typeof vi.fn>; fetch: ReturnType<typeof vi.fn> } }> = []

vi.mock('./client-factory', () => ({
  createContainerClient: (_config: unknown, runner: ContainerRunner) => {
    const client = {
      start: vi.fn().mockResolvedValue({ status: 'running', port: 4001 }),
      stop: vi.fn().mockResolvedValue({ forceStopUsed: false, stopped: true }),
      stopSync: vi.fn(),
      getInfoFromRuntime: vi.fn().mockResolvedValue({ status: 'running', port: 4001 }),
      getStats: vi.fn(),
      fetch: vi.fn(),
      getHostApiBaseUrl: () => 'http://127.0.0.1:3000',
      onFatalResult: () => 'settle',
      getRuntimeGenerationId: () => null,
    }
    built.push({ runner, client })
    return client
  },
  getContainerClientClass: () => ({ requiresLocalImage: true }),
  checkAllRunnersAvailability: vi.fn().mockResolvedValue([]),
  checkImageExists: vi.fn().mockResolvedValue(true),
  pullImage: vi.fn(),
  canBuildImage: vi.fn().mockReturnValue(false),
  buildImage: vi.fn(),
  startRunner: vi.fn(),
  refreshRunnerAvailability: vi.fn(),
  clearRunnerAvailabilityCache: vi.fn(),
  getRunnerDisplayName: (runner: string) => runner,
  reconcileRunnerState: vi.fn().mockResolvedValue(false),
}))

vi.mock('./volume-stop', () => ({ prepareVolumeStop: vi.fn(async () => {}) }))

vi.mock('@shared/lib/proxy/token-store', () => ({
  getOrCreateProxyToken: vi.fn().mockResolvedValue('test-token'),
}))

vi.mock('@shared/lib/container/host-token-store', () => ({
  getOrCreateHostToken: vi.fn(async () => 'test-host-token'),
}))

vi.mock('@shared/lib/proxy/host-url', () => ({
  getContainerHostUrl: () => '127.0.0.1',
  getAppPort: () => 3000,
}))

vi.mock('@shared/lib/db', () => ({
  db: {
    select: () => ({
      from: () => ({ innerJoin: () => ({ where: vi.fn().mockResolvedValue([]) }) }),
    }),
  },
}))

vi.mock('@shared/lib/db/schema', () => ({
  connectedAccounts: { id: 'id' },
  agentConnectedAccounts: 'agent_connected_accounts_table',
  agentRemoteMcps: 'agent_remote_mcps_table',
  remoteMcpServers: 'remote_mcp_servers_table',
}))

vi.mock('drizzle-orm', () => ({
  eq: (col: string, val: string) => ({ col, val }),
}))

// The runner as the database holds it now; a read can be held to land late.
let storedRunner: ContainerRunner = 'docker'
const readSettings = vi.fn(async () => ({
  container: { agentImage: 'test-image', containerRunner: storedRunner },
  app: {},
}))

vi.mock('@shared/lib/config/settings', () => ({
  getSettings: () => readSettings(),
}))

vi.mock('@shared/lib/config/data-dir', () => ({
  getAgentWorkspaceDir: (id: string) => `/workspace/${id}`,
}))

vi.mock('./health-monitor', () => ({
  healthMonitor: { checkAll: vi.fn().mockReturnValue([]) },
}))

vi.mock('@shared/lib/services/agent-service', () => ({}))

vi.mock('@shared/lib/composio/client', () => ({
  isPlatformComposioActive: async () => false,
}))

vi.mock('@shared/lib/services/timezone-resolver', () => ({
  resolveTimezoneForAgent: () => 'UTC',
}))

vi.mock('@shared/lib/services/mount-service', () => ({
  listVolumes: async () => ({ volumes: [], notMounted: [] }),
  remounted: async () => {},
}))

import { containerHost } from './container-host'

const SLUG = 'agent-runner'

// ============================================================================
// The client follows the configured runner
//
// The runner is a setting another process can change (the settings route of
// another server, or the readiness check's auto-switch here). A runtime reads
// it on every use and replaces a client built for another runner.
// ============================================================================

describe('ContainerRuntime client for the configured runner', () => {
  beforeEach(() => {
    built.length = 0
    storedRunner = 'docker'
    readSettings.mockClear()
    containerHost.dropRuntime(SLUG)
  })

  it('builds one client for the configured runner and keeps it while the runner stays', async () => {
    const runtime = containerHost.runtime(SLUG)
    const first = await runtime.getClient()
    expect(await runtime.getClient()).toBe(first)
    expect(built.map((b) => b.runner)).toEqual(['docker'])
    // Read fresh on every use, never kept.
    expect(readSettings).toHaveBeenCalledTimes(2)
  })

  it('replaces the client on its next use when the runner changed elsewhere', async () => {
    const runtime = containerHost.runtime(SLUG)
    const docker = await runtime.getClient()

    storedRunner = 'podman'
    const podman = await runtime.getClient()

    expect(podman).not.toBe(docker)
    expect(built.map((b) => b.runner)).toEqual(['docker', 'podman'])
    expect(await runtime.getClient()).toBe(podman)
  })

  it('a slow read of the old runner never replaces the client a newer read built', async () => {
    const runtime = containerHost.runtime(SLUG)
    await runtime.getClient()

    // The first read sees docker but lands late; the second sees podman.
    let landOldRead!: () => void
    readSettings.mockImplementationOnce(() => new Promise((resolve) => {
      landOldRead = () => resolve({ container: { agentImage: 'test-image', containerRunner: 'docker' }, app: {} })
    }))
    const stale = runtime.getClient()
    storedRunner = 'podman'
    const fresh = await runtime.getClient()
    landOldRead()

    expect(await stale).toBe(fresh)
    expect(built.map((b) => b.runner)).toEqual(['docker', 'podman'])
    expect(await runtime.getClient()).toBe(fresh)
  })

  it('a stop goes through the client that started the container, even after the runner changed', async () => {
    const runtime = containerHost.runtime(SLUG)
    await runtime.ensureRunning()
    const starter = built[0].client

    storedRunner = 'podman'
    await runtime.stopContainer()

    expect(starter.stop).toHaveBeenCalledTimes(1)
    expect(built).toHaveLength(1)
    // The next start uses the runner configured now.
    await runtime.ensureRunning()
    expect(built.map((b) => b.runner)).toEqual(['docker', 'podman'])
  })
})
