import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentConfig } from '@shared/lib/types/agent'

const mockListAgents = vi.fn()
const mockReadAgentPreferences = vi.fn()
const mockGetSettings = vi.fn()
const mockPrune = vi.fn()

vi.mock('@shared/lib/services/agent-service', () => ({
  listAgents: () => mockListAgents(),
}))

vi.mock('@shared/lib/services/agent-preferences-service', () => ({
  readStoredAgentPreferences: (slug: string) => mockReadAgentPreferences(slug),
  // The resolving read costs a settings read per agent with a default model; the sweep must not use it.
  readAgentPreferences: async (slug: string) => {
    await mockGetSettings()
    return mockReadAgentPreferences(slug)
  },
}))

vi.mock('@shared/lib/config/settings', () => ({
  getSettings: () => mockGetSettings(),
}))

vi.mock('@shared/lib/services/api-log-auto-delete', () => ({
  pruneExpiredApiLogsForAgent: (...args: unknown[]) => mockPrune(...args),
}))

vi.mock('@shared/lib/db', () => ({
  db: {},
}))

vi.mock('@shared/lib/error-reporting', () => ({
  captureException: vi.fn(),
}))

import { apiLogAutoDeleteMonitor } from './api-log-auto-delete-monitor'
import { registerTasks } from '@shared/lib/background-work/testing/register-tasks'

beforeEach(() => registerTasks(apiLogAutoDeleteMonitor))

function makeAgent(slug: string): AgentConfig {
  return {
    slug,
    frontmatter: { name: slug, createdAt: '2026-01-01T00:00:00Z' },
    instructions: '',
  }
}

describe('ApiLogAutoDeleteMonitor', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    mockGetSettings.mockReturnValue({ app: { apiLogAutoDeleteDays: 30 } })
    mockListAgents.mockResolvedValue([])
    mockReadAgentPreferences.mockResolvedValue({})
    mockPrune.mockResolvedValue({ proxyDeleted: 0, mcpDeleted: 0 })
  })

  afterEach(() => {
    apiLogAutoDeleteMonitor.stop()
    vi.useRealTimers()
  })

  async function startAndTrigger() {
    await apiLogAutoDeleteMonitor.start()
    await vi.advanceTimersByTimeAsync(30_000)
  }

  it('does not run cleanup immediately on start', async () => {
    mockListAgents.mockResolvedValue([makeAgent('agent-1')])
    await apiLogAutoDeleteMonitor.start()
    expect(mockListAgents).not.toHaveBeenCalled()
  })

  it('runs cleanup after the startup delay', async () => {
    await startAndTrigger()
    expect(mockListAgents).toHaveBeenCalledOnce()
  })

  it('defaults to 30 days when the app setting is unset', async () => {
    mockGetSettings.mockReturnValue({ app: {} })
    mockListAgents.mockResolvedValue([makeAgent('test-agent')])

    await startAndTrigger()

    expect(mockPrune).toHaveBeenCalledOnce()
    expect(mockPrune.mock.calls[0][1]).toBe('test-agent')
    expect(mockPrune.mock.calls[0][2]).toBe(Date.now() - 30 * 86_400_000)
  })

  it('skips prune when the effective setting is Never (0)', async () => {
    mockGetSettings.mockReturnValue({ app: { apiLogAutoDeleteDays: 0 } })
    mockListAgents.mockResolvedValue([makeAgent('test-agent')])

    await startAndTrigger()

    expect(mockPrune).not.toHaveBeenCalled()
  })

  it('uses the per-agent override over the app default', async () => {
    mockGetSettings.mockReturnValue({ app: { apiLogAutoDeleteDays: 30 } })
    mockListAgents.mockResolvedValue([makeAgent('test-agent')])
    mockReadAgentPreferences.mockResolvedValue({ apiLogAutoDeleteDays: 90 })

    await startAndTrigger()

    expect(mockPrune).toHaveBeenCalledOnce()
    expect(mockPrune.mock.calls[0][1]).toBe('test-agent')
    expect(mockPrune.mock.calls[0][2]).toBe(Date.now() - 90 * 86_400_000)
  })

  it('honors Never on the agent even when the app default is 30', async () => {
    mockGetSettings.mockReturnValue({ app: { apiLogAutoDeleteDays: 30 } })
    mockListAgents.mockResolvedValue([makeAgent('test-agent')])
    mockReadAgentPreferences.mockResolvedValue({ apiLogAutoDeleteDays: 0 })

    await startAndTrigger()

    expect(mockPrune).not.toHaveBeenCalled()
  })

  it('reads the settings once per sweep, however many agents it sweeps', async () => {
    mockGetSettings.mockReturnValue({ app: { apiLogAutoDeleteDays: 30 } })
    mockReadAgentPreferences.mockResolvedValue({ defaultModel: 'model-a' })
    const readsFor = async (count: number) => {
      mockListAgents.mockResolvedValue(Array.from({ length: count }, (_, i) => makeAgent(`agent-${i}`)))
      mockGetSettings.mockClear()
      await Reflect.get(apiLogAutoDeleteMonitor, 'cleanupAllAgents').call(apiLogAutoDeleteMonitor)
      return mockGetSettings.mock.calls.length
    }
    expect(await readsFor(1)).toBe(1)
    expect(await readsFor(5)).toBe(1)
    // A change committed between two sweeps is what the next one sees.
    mockListAgents.mockResolvedValue([makeAgent('test-agent')])
    mockPrune.mockClear()
    mockGetSettings.mockReturnValue({ app: { apiLogAutoDeleteDays: 7 } })
    await Reflect.get(apiLogAutoDeleteMonitor, 'cleanupAllAgents').call(apiLogAutoDeleteMonitor)
    expect(mockPrune.mock.calls[0][2]).toBe(Date.now() - 7 * 86_400_000)
  })
})
