// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RuntimeTab } from './runtime-tab'
import { renderWithProviders } from '@renderer/test/test-utils'
import { getDefaultAgentImage } from '@shared/lib/config/version'

// Shims for Radix Select in jsdom.
Element.prototype.scrollIntoView = vi.fn()
Element.prototype.hasPointerCapture = vi.fn(() => false)
Element.prototype.releasePointerCapture = vi.fn()

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

  it('resets agent image to the latest default', async () => {
    const user = userEvent.setup()
    mockSettings.data.container.agentImage = 'ghcr.io/custom/image:latest'

    renderWithProviders(<RuntimeTab />)

    await user.click(screen.getByRole('button', { name: 'Use default' }))

    expect(screen.getByLabelText('Agent Image')).toHaveValue(getDefaultAgentImage())
  })

  describe('non-standard resource limits', () => {
    it('preserves a non-standard CPU value in the dropdown trigger', () => {
      mockSettings.data.container.resourceLimits = { cpu: 1.5 as number, memory: '1g' }

      renderWithProviders(<RuntimeTab />)

      const cpuTrigger = screen.getByRole('combobox', { name: 'CPU Limit' })
      expect(cpuTrigger).toHaveTextContent('1.5 cores')
    })

    it('preserves a non-standard memory value in the dropdown trigger', () => {
      mockSettings.data.container.resourceLimits = { cpu: 2, memory: '3g' }

      renderWithProviders(<RuntimeTab />)

      const memoryTrigger = screen.getByRole('combobox', { name: 'Memory Limit' })
      expect(memoryTrigger).toHaveTextContent('3g')
    })

    it('saves a standard CPU value once the user picks one from the dropdown', async () => {
      const user = userEvent.setup()
      mockSettings.data.container.resourceLimits = { cpu: 1.5 as number, memory: '1g' }

      renderWithProviders(<RuntimeTab />)

      const cpuTrigger = screen.getByRole('combobox', { name: 'CPU Limit' })
      cpuTrigger.focus()
      // Radix Select in jsdom is unreliable via click; keyboard nav is deterministic.
      await user.keyboard('[Enter]')
      const option = await screen.findByRole('option', { name: '4 cores' })
      await user.click(option)

      expect(cpuTrigger).toHaveTextContent('4 cores')

      await user.click(screen.getByRole('button', { name: 'Save' }))

      expect(mockUpdateSettings.mutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          container: expect.objectContaining({
            resourceLimits: { cpu: 4, memory: '1g' },
          }),
        })
      )
    })
  })
})
