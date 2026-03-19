// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RuntimeTab } from './runtime-tab'
import { renderWithProviders } from '@renderer/test/test-utils'

const mockSettings = {
  data: {
    container: {
      containerRunner: 'docker',
      agentImage: 'ghcr.io/skillfulagents/superagent-agent-container-base:latest',
      resourceLimits: {
        cpu: 1,
        memory: '1g',
      },
      runtimeSettings: {},
    },
    runnerAvailability: [
      {
        runner: 'docker',
        installed: true,
        running: true,
        available: true,
        canStart: false,
      },
    ],
    runtimeReadiness: { status: 'READY', message: 'Ready' },
    hasRunningAgents: false,
    customEnvVars: {},
    dataDir: '/tmp/superagent',
    app: { autoSleepTimeoutMinutes: 30 },
    agentLimits: {},
  },
  isLoading: false,
}

const mockUpdateSettings = {
  mutateAsync: vi.fn().mockResolvedValue({}),
  mutate: vi.fn(),
  isPending: false,
  error: null as { error: string } | null,
}

const mockStartRunner = {
  mutateAsync: vi.fn(),
  isPending: false,
  isSuccess: false,
  data: undefined as { message?: string } | undefined,
  error: null as Error | null,
}

const mockRestartRunner = {
  mutateAsync: vi.fn(),
  isPending: false,
  isSuccess: false,
  data: undefined as { message?: string } | undefined,
  error: null as Error | null,
}

const mockRefreshAvailability = {
  mutate: vi.fn(),
  isPending: false,
}

vi.mock('@renderer/hooks/use-settings', () => ({
  useSettings: () => mockSettings,
  useUpdateSettings: () => mockUpdateSettings,
  useStartRunner: () => mockStartRunner,
  useRestartRunner: () => mockRestartRunner,
  useRefreshAvailability: () => mockRefreshAvailability,
}))

describe('RuntimeTab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSettings.data.container.agentImage = 'ghcr.io/skillfulagents/superagent-agent-container-base:latest'
    mockUpdateSettings.isPending = false
    mockUpdateSettings.error = null
  })

  it('disables save when agent image is blank', async () => {
    const user = userEvent.setup()
    renderWithProviders(<RuntimeTab />)

    const agentImageInput = screen.getByLabelText('Agent Image')
    await user.clear(agentImageInput)
    await user.type(agentImageInput, '   ')

    expect(screen.getByText('Agent image is required.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('trims agent image before saving', async () => {
    const user = userEvent.setup()
    renderWithProviders(<RuntimeTab />)

    const agentImageInput = screen.getByLabelText('Agent Image')
    await user.clear(agentImageInput)
    await user.type(agentImageInput, '  ghcr.io/custom/image:latest  ')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(mockUpdateSettings.mutateAsync).toHaveBeenCalledWith({
      container: {
        containerRunner: 'docker',
        agentImage: 'ghcr.io/custom/image:latest',
        resourceLimits: {
          cpu: 1,
          memory: '1g',
        },
      },
    })
  })
})
