// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RuntimeTab } from './runtime-tab'
import { renderWithProviders } from '@renderer/test/test-utils'
import { getDefaultAgentImage } from '@shared/lib/config/version'

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
    mockSettings.data.customEnvVars = {}
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

  it('resets agent image to the latest default', async () => {
    const user = userEvent.setup()
    mockSettings.data.container.agentImage = 'ghcr.io/custom/image:latest'

    renderWithProviders(<RuntimeTab />)

    await user.click(screen.getByRole('button', { name: 'Use default' }))

    expect(screen.getByLabelText('Agent Image')).toHaveValue(getDefaultAgentImage())
  })

  it('adds a custom environment variable through the dialog', async () => {
    const user = userEvent.setup()
    renderWithProviders(<RuntimeTab />)

    await user.click(screen.getByRole('button', { name: 'Add Variable' }))
    await user.type(screen.getByLabelText('Variable Name'), 'claude code max output tokens')
    await user.type(screen.getByLabelText('Value'), '32000')
    const dialog = screen.getByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Add Variable' }))

    expect(mockUpdateSettings.mutateAsync).toHaveBeenCalledWith({
      customEnvVars: {
        CLAUDE_CODE_MAX_OUTPUT_TOKENS: '32000',
      },
    })
  })

  it('saves edited custom env vars with the full current draft', async () => {
    const user = userEvent.setup()
    mockSettings.data.customEnvVars = {
      FOO: 'one',
      BAR: 'two',
    }

    renderWithProviders(<RuntimeTab />)

    const fooInput = screen.getByDisplayValue('one')
    await user.clear(fooInput)
    await user.type(fooInput, 'updated')
    await user.tab()

    expect(mockUpdateSettings.mutateAsync).toHaveBeenCalledWith({
      customEnvVars: {
        FOO: 'updated',
        BAR: 'two',
      },
    })
  })
})
