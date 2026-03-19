// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent } from '@testing-library/react'
import { screen, waitFor } from '@renderer/test/test-utils'
import userEvent from '@testing-library/user-event'
import { renderWithProviders } from '@renderer/test/test-utils'
import { CreateAgentDialog } from './create-agent-dialog'

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

vi.stubGlobal('ResizeObserver', ResizeObserverMock)

const mockSelectAgent = vi.fn()
const mockSelectSession = vi.fn()
const mockTrack = vi.fn()
const mockImportMutateAsync = vi.fn()
const mockImportReset = vi.fn()
const mockCreateSession = {
  mutateAsync: vi.fn(),
  isPending: false,
}
const mockCreateAgent = {
  mutateAsync: vi.fn(),
  isPending: false,
}
const mockInstallSkill = {
  mutateAsync: vi.fn(),
  isPending: false,
}
const mockInstallFromSkillset = {
  mutateAsync: vi.fn(),
  isPending: false,
}

vi.mock('@renderer/hooks/use-agents', () => ({
  useCreateAgent: () => mockCreateAgent,
  useDeleteAgent: () => ({ mutateAsync: vi.fn() }),
}))

vi.mock('@renderer/hooks/use-sessions', () => ({
  useCreateSession: () => mockCreateSession,
}))

vi.mock('@renderer/context/selection-context', () => ({
  useSelection: () => ({
    selectAgent: mockSelectAgent,
    selectSession: mockSelectSession,
  }),
}))

vi.mock('@renderer/context/analytics-context', () => ({
  useAnalyticsTracking: () => ({
    track: mockTrack,
  }),
}))

vi.mock('@renderer/hooks/use-skillsets', () => ({
  useSkillsets: () => ({ data: [] }),
}))

vi.mock('@renderer/hooks/use-agent-skills', () => ({
  useInstallSkill: () => mockInstallSkill,
}))

vi.mock('@renderer/hooks/use-agent-templates', () => ({
  useDiscoverableAgents: () => ({ data: undefined }),
  useImportAgentTemplate: () => ({
    mutateAsync: mockImportMutateAsync,
    reset: mockImportReset,
    isPending: false,
    error: null,
  }),
  useInstallAgentFromSkillset: () => mockInstallFromSkillset,
}))

describe('CreateAgentDialog import flow', () => {
  const onOpenChange = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    mockImportMutateAsync.mockResolvedValue({
      slug: 'imported-agent',
      name: 'Imported Agent',
      hasOnboarding: false,
      requiredEnvVars: [],
    })
  })

  async function prepareImport(user: ReturnType<typeof userEvent.setup>) {
    renderWithProviders(
      <CreateAgentDialog open={true} onOpenChange={onOpenChange} />
    )

    await user.click(screen.getByRole('tab', { name: 'Import File' }))

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement | null
    expect(fileInput).not.toBeNull()

    const file = new File(['zip-bytes'], 'agent.zip', { type: 'application/zip' })
    fireEvent.change(fileInput!, { target: { files: [file] } })

    await user.click(screen.getByLabelText('Full import (includes environment variables and data)'))

    return file
  }

  it('does not open the secrets prompt when a full import has no missing env vars', async () => {
    const user = userEvent.setup()
    const file = await prepareImport(user)

    await user.click(screen.getByRole('button', { name: 'Import' }))

    await waitFor(() => {
      expect(mockImportMutateAsync).toHaveBeenCalledWith(expect.objectContaining({
        file,
        nameOverride: undefined,
        mode: 'full',
      }))
    })

    expect(screen.queryByText('Install agent template')).not.toBeInTheDocument()
    expect(mockSelectAgent).toHaveBeenCalledWith('imported-agent')
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('opens the secrets prompt with only the missing env vars for a partial full import', async () => {
    mockImportMutateAsync.mockResolvedValue({
      slug: 'imported-agent',
      name: 'Imported Agent',
      hasOnboarding: false,
      requiredEnvVars: [
        { name: 'SECRET_A', description: 'Secret for A' },
      ],
    })

    const user = userEvent.setup()
    await prepareImport(user)

    await user.click(screen.getByRole('button', { name: 'Import' }))

    expect(await screen.findByText('Install agent template')).toBeInTheDocument()
    expect(screen.getByText('SECRET_A')).toBeInTheDocument()
    expect(screen.queryByText('API_KEY')).not.toBeInTheDocument()
    expect(mockSelectAgent).not.toHaveBeenCalled()
  })
})
