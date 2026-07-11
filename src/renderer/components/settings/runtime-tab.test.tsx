// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, within } from '@testing-library/react'
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
      runtimeSettings: {} as Record<string, Record<string, string>>,
    },
    hostTotalMemoryBytes: 64 * 1024 ** 3,
    runnerAvailability: [
      {
        runner: 'docker',
        installed: true,
        running: true,
        available: true,
        canStart: false,
        supportsCustomAgentImage: true,
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
    mockSettings.data.container.containerRunner = 'docker'
    mockSettings.data.container.agentImage = 'ghcr.io/skillfulagents/superagent-agent-container-base:latest'
    mockSettings.data.container.runtimeSettings = {}
    mockSettings.data.hostTotalMemoryBytes = 64 * 1024 ** 3
    mockSettings.data.customEnvVars = {}
    mockSettings.data.runnerAvailability = [
      {
        runner: 'docker',
        installed: true,
        running: true,
        available: true,
        canStart: false,
        supportsCustomAgentImage: true,
      },
    ]
    mockUpdateSettings.isPending = false
    mockUpdateSettings.error = null
  })

  it('disables save when agent image is blank', async () => {
    renderWithProviders(<RuntimeTab />)

    const agentImageInput = screen.getByLabelText('Agent Image')
    fireEvent.change(agentImageInput, { target: { value: '   ' } })

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

  describe('runner without custom agent image support (e.g. lambda-microvm)', () => {
    beforeEach(() => {
      mockSettings.data.container.containerRunner = 'lambda-microvm'
      mockSettings.data.runnerAvailability = [
        {
          runner: 'lambda-microvm',
          installed: true,
          running: true,
          available: true,
          canStart: false,
          supportsCustomAgentImage: false,
        },
      ]
    })

    it('disables the Agent Image input and hides Use default', () => {
      renderWithProviders(<RuntimeTab />)

      expect(screen.getByLabelText('Agent Image')).toBeDisabled()
      expect(screen.queryByRole('button', { name: 'Use default' })).not.toBeInTheDocument()
      expect(
        screen.getByText('Agent image is managed by the deployment for this runner and cannot be changed here.')
      ).toBeInTheDocument()
    })

    it('does not treat a blank persisted agent image as a validation error', () => {
      mockSettings.data.container.agentImage = ''

      renderWithProviders(<RuntimeTab />)

      expect(screen.queryByText('Agent image is required.')).not.toBeInTheDocument()
    })
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

  it('rejects a reserved env var: shows the error, does not save, and does not keep the row (SUP-239 bug 1)', async () => {
    const user = userEvent.setup()
    renderWithProviders(<RuntimeTab />)

    await user.click(screen.getByRole('button', { name: 'Add Variable' }))
    await user.type(screen.getByLabelText('Variable Name'), 'PROXY_BASE_URL')
    await user.type(screen.getByLabelText('Value'), 'evil')
    const dialog = screen.getByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Add Variable' }))

    // The reserved-runtime-var error is surfaced…
    expect(await screen.findByText(/reserved runtime variable/i)).toBeInTheDocument()
    // …the value is never sent to the server (client-side guard)…
    expect(mockUpdateSettings.mutateAsync).not.toHaveBeenCalled()
    // …and the rejected row does not linger as if it had been saved.
    expect(screen.queryByDisplayValue('PROXY_BASE_URL')).not.toBeInTheDocument()
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

  describe('Lima VM memory guardrails', () => {
    beforeEach(() => {
      mockSettings.data.container.containerRunner = 'lima'
      mockSettings.data.runnerAvailability = [
        {
          runner: 'lima',
          installed: true,
          running: true,
          available: true,
          canStart: false,
          supportsCustomAgentImage: true,
        },
      ]
      // A 16 GB machine — the Jessica configuration.
      mockSettings.data.hostTotalMemoryBytes = 16 * 1024 ** 3
    })

    it('disables VM memory options at or above the machine total', async () => {
      const user = userEvent.setup()
      renderWithProviders(<RuntimeTab />)

      const trigger = screen.getByRole('combobox', { name: 'VM Memory' })
      trigger.focus()
      await user.keyboard('[Enter]')

      const oversized = await screen.findByRole('option', { name: /16 GB \(exceeds system memory\)/ })
      expect(oversized).toHaveAttribute('aria-disabled', 'true')
      // Options that fit stay selectable.
      const fits = screen.getByRole('option', { name: '8 GB' })
      expect(fits).not.toHaveAttribute('aria-disabled', 'true')
    })

    it('warns when the saved VM memory is more than half of the machine total', () => {
      mockSettings.data.container.runtimeSettings = { lima: { vmMemory: '12GiB' } }

      renderWithProviders(<RuntimeTab />)

      expect(screen.getByText(/more than half of this machine's 16 GB/)).toBeInTheDocument()
    })

    it('shows no warning at or below half of the machine total', () => {
      mockSettings.data.container.runtimeSettings = { lima: { vmMemory: '8GiB' } }

      renderWithProviders(<RuntimeTab />)

      expect(screen.queryByText(/more than half/)).not.toBeInTheDocument()
    })

    it('flags a legacy persisted oversized value (saved before the guardrail existed)', () => {
      mockSettings.data.container.runtimeSettings = { lima: { vmMemory: '16GiB' } }

      renderWithProviders(<RuntimeTab />)

      expect(screen.getByText(/must be smaller than this machine's total memory/)).toBeInTheDocument()
    })
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
