// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AgentHome } from './agent-home'
import { renderWithProviders } from '@renderer/test/test-utils'
import type { ApiAgent } from '@renderer/hooks/use-agents'

// --- Mock data ---

const testAgent: ApiAgent = {
  slug: 'test-agent',
  name: 'Test Agent',
  description: 'A test agent',
  createdAt: new Date('2025-01-01'),
  status: 'running',
  containerPort: 3000,
}

// --- Mocks ---

const mockCreateSession = {
  mutateAsync: vi.fn().mockResolvedValue({ id: 'session-123' }),
  isPending: false,
}

vi.mock('@renderer/hooks/use-sessions', () => ({
  useCreateSession: () => mockCreateSession,
  useSessions: () => ({ data: [] }),
}))

vi.mock('@renderer/hooks/use-scheduled-tasks', () => ({
  useScheduledTasks: () => ({ data: [] }),
  useRunScheduledTaskNow: () => ({ mutate: vi.fn(), isPending: false }),
  useCancelScheduledTask: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
}))

vi.mock('@renderer/context/selection-context', () => ({
  useSelection: () => ({
    selectScheduledTask: vi.fn(),
    selectSession: vi.fn(),
    selectAgent: vi.fn(),
  }),
}))

const mockComposer = {
  message: '',
  setMessage: vi.fn(),
  attachments: [] as any[],
  isDragOver: false,
  removeAttachment: vi.fn(),
  handleFileSelect: vi.fn(),
  handleFolderSelect: vi.fn(),
  dragHandlers: {
    onDragOver: vi.fn(),
    onDragLeave: vi.fn(),
    onDrop: vi.fn(),
  },
  voiceInput: {
    state: 'idle',
    isRecording: false,
    isConnecting: false,
    error: null,
    clearError: vi.fn(),
    isSupported: true,
    analyserRef: { current: null },
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
  },
  mountDialog: {
    open: false,
    onChoice: vi.fn(),
    folderName: undefined as string | undefined,
  },
  isUploading: false,
  handleSubmit: vi.fn(),
  handlePaste: vi.fn(),
  canSubmit: false,
}

let capturedComposerOptions: any

vi.mock('@renderer/hooks/use-message-composer', () => ({
  useMessageComposer: (opts: any) => {
    capturedComposerOptions = opts
    return mockComposer
  },
}))

vi.mock('@renderer/hooks/use-humanized-cron', () => ({
  useHumanizedCron: () => null,
}))

vi.mock('@renderer/hooks/use-agent-skills', () => ({
  useAgentSkills: () => ({ data: [] }),
  useDiscoverableSkills: () => ({ data: [] }),
  useRefreshAgentSkills: () => ({ mutate: vi.fn(), isPending: false }),
}))

const mockRuntimeStatus = {
  data: {
    runtimeReadiness: { status: 'READY' as string, message: 'Ready' },
    hasRunningAgents: true,
    apiKeyConfigured: true,
  },
  isPending: false,
}

vi.mock('@renderer/hooks/use-runtime-status', () => ({
  useRuntimeStatus: () => mockRuntimeStatus,
}))

// Mock user context — default to full access, override for view-only tests
let mockCanUseAgent = true
let mockCanAdminAgent = false

vi.mock('@renderer/context/user-context', () => ({
  useUser: () => ({
    canUseAgent: () => mockCanUseAgent,
    canAdminAgent: () => mockCanAdminAgent,
  }),
  UserProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

describe('AgentHome', () => {
  const onSessionCreated = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    mockCreateSession.isPending = false
    mockCreateSession.mutateAsync.mockResolvedValue({ id: 'session-123' })
    mockComposer.message = ''
    mockComposer.attachments = []
    mockComposer.isUploading = false
    mockComposer.canSubmit = false
    mockComposer.isDragOver = false
    mockRuntimeStatus.data.runtimeReadiness.status = 'READY'
    mockRuntimeStatus.data.apiKeyConfigured = true
    mockRuntimeStatus.isPending = false
    mockCanUseAgent = true
    mockCanAdminAgent = false
    capturedComposerOptions = undefined
  })

  // --- Rendering ---

  it('renders landing page with agent name', () => {
    renderWithProviders(
      <AgentHome agent={testAgent} onSessionCreated={onSessionCreated} />
    )
    expect(screen.getByText('Test Agent')).toBeInTheDocument()
  })

  it('renders textarea with placeholder', () => {
    renderWithProviders(
      <AgentHome agent={testAgent} onSessionCreated={onSessionCreated} />
    )
    expect(screen.getByTestId('home-message-input')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('How can I help? Press cmd+enter to send')).toBeInTheDocument()
  })

  it('renders send button', () => {
    renderWithProviders(
      <AgentHome agent={testAgent} onSessionCreated={onSessionCreated} />
    )
    expect(screen.getByTestId('home-send-button')).toBeInTheDocument()
  })

  // --- Send button disabled state ---

  it('send button is disabled when canSubmit is false', () => {
    mockComposer.canSubmit = false
    renderWithProviders(
      <AgentHome agent={testAgent} onSessionCreated={onSessionCreated} />
    )
    expect(screen.getByTestId('home-send-button')).toBeDisabled()
  })

  it('send button is enabled when canSubmit is true', () => {
    mockComposer.canSubmit = true
    renderWithProviders(
      <AgentHome agent={testAgent} onSessionCreated={onSessionCreated} />
    )
    expect(screen.getByTestId('home-send-button')).not.toBeDisabled()
  })

  // --- Cmd+Enter submission ---

  it('submits on Cmd+Enter', async () => {
    const user = userEvent.setup()
    mockComposer.canSubmit = true
    renderWithProviders(
      <AgentHome agent={testAgent} onSessionCreated={onSessionCreated} />
    )

    const input = screen.getByTestId('home-message-input')
    await user.click(input)
    await user.keyboard('{Meta>}{Enter}{/Meta}')

    expect(mockComposer.handleSubmit).toHaveBeenCalled()
  })

  it('submits on Ctrl+Enter', async () => {
    const user = userEvent.setup()
    mockComposer.canSubmit = true
    renderWithProviders(
      <AgentHome agent={testAgent} onSessionCreated={onSessionCreated} />
    )

    const input = screen.getByTestId('home-message-input')
    await user.click(input)
    await user.keyboard('{Control>}{Enter}{/Control}')

    expect(mockComposer.handleSubmit).toHaveBeenCalled()
  })

  it('does not submit on plain Enter', async () => {
    const user = userEvent.setup()
    renderWithProviders(
      <AgentHome agent={testAgent} onSessionCreated={onSessionCreated} />
    )

    const input = screen.getByTestId('home-message-input')
    await user.click(input)
    await user.keyboard('{Enter}')

    expect(mockComposer.handleSubmit).not.toHaveBeenCalled()
  })

  // --- Disabled state ---

  it('disables input when runtime is not ready', () => {
    mockRuntimeStatus.data.runtimeReadiness.status = 'PULLING_IMAGE'
    mockRuntimeStatus.isPending = false
    renderWithProviders(
      <AgentHome agent={testAgent} onSessionCreated={onSessionCreated} />
    )
    expect(screen.getByTestId('home-message-input')).toBeDisabled()
  })

  it('disables input when createSession is pending', () => {
    mockCreateSession.isPending = true
    renderWithProviders(
      <AgentHome agent={testAgent} onSessionCreated={onSessionCreated} />
    )
    expect(screen.getByTestId('home-message-input')).toBeDisabled()
  })

  it('disables input when uploading', () => {
    mockComposer.isUploading = true
    renderWithProviders(
      <AgentHome agent={testAgent} onSessionCreated={onSessionCreated} />
    )
    expect(screen.getByTestId('home-message-input')).toBeDisabled()
  })

  // --- Auto-expand ---

  it('auto-expands when the message is very long', () => {
    mockComposer.message = 'one\ntwo\nthree\nfour\nfive'
    renderWithProviders(
      <AgentHome agent={testAgent} onSessionCreated={onSessionCreated} />
    )

    expect(screen.getByTestId('home-message-input').className).toContain('min-h-[50vh]')
  })

  // --- View-only mode ---

  it('shows view-only banner when user lacks permissions', () => {
    mockCanUseAgent = false

    renderWithProviders(
      <AgentHome agent={testAgent} onSessionCreated={onSessionCreated} />
    )

    expect(screen.getByTestId('view-only-banner')).toBeInTheDocument()
    expect(screen.queryByTestId('home-message-input')).not.toBeInTheDocument()
  })

  it('shows agent name in view-only mode', () => {
    mockCanUseAgent = false

    renderWithProviders(
      <AgentHome agent={testAgent} onSessionCreated={onSessionCreated} />
    )

    expect(screen.getByText('Test Agent')).toBeInTheDocument()
  })

  // --- API key warning ---

  it('shows API key warning when not configured', () => {
    mockRuntimeStatus.data.apiKeyConfigured = false
    renderWithProviders(
      <AgentHome agent={testAgent} onSessionCreated={onSessionCreated} />
    )
    expect(screen.getByText('No API key configured. An administrator needs to set up the LLM API key.')).toBeInTheDocument()
  })

  // --- Runtime readiness messages ---

  it('shows runtime status message when not ready', () => {
    mockRuntimeStatus.data.runtimeReadiness.status = 'PULLING_IMAGE'
    mockRuntimeStatus.data.runtimeReadiness.message = 'Pulling container image...'
    mockRuntimeStatus.isPending = false
    renderWithProviders(
      <AgentHome agent={testAgent} onSessionCreated={onSessionCreated} />
    )
    expect(screen.getByText('Pulling container image...')).toBeInTheDocument()
  })

  // --- Drag-and-drop visual feedback ---

  it('shows ring when dragging over', () => {
    mockComposer.isDragOver = true
    const { container } = renderWithProviders(
      <AgentHome agent={testAgent} onSessionCreated={onSessionCreated} />
    )
    const form = container.querySelector('form')!
    expect(form.className).toContain('ring-2')
  })

  it('no ring when not dragging', () => {
    mockComposer.isDragOver = false
    const { container } = renderWithProviders(
      <AgentHome agent={testAgent} onSessionCreated={onSessionCreated} />
    )
    const form = container.querySelector('form')!
    expect(form.className).not.toContain('ring-2')
  })

  // --- Composer integration ---

  it('passes correct agentSlug to useMessageComposer', () => {
    renderWithProviders(
      <AgentHome agent={testAgent} onSessionCreated={onSessionCreated} />
    )
    expect(capturedComposerOptions.agentSlug).toBe('test-agent')
  })

  it('passes a namespaced draftKey so the composer persists per agent', () => {
    renderWithProviders(
      <AgentHome agent={testAgent} onSessionCreated={onSessionCreated} />
    )
    expect(capturedComposerOptions.draftKey).toBe('agent:test-agent')
  })

  it('passes submitDisabled based on createSession.isPending and runtime readiness', () => {
    mockCreateSession.isPending = false
    mockRuntimeStatus.data.runtimeReadiness.status = 'READY'
    renderWithProviders(
      <AgentHome agent={testAgent} onSessionCreated={onSessionCreated} />
    )
    expect(capturedComposerOptions.submitDisabled).toBe(false)
  })

  it('passes submitDisabled=true when createSession is pending', () => {
    mockCreateSession.isPending = true
    renderWithProviders(
      <AgentHome agent={testAgent} onSessionCreated={onSessionCreated} />
    )
    expect(capturedComposerOptions.submitDisabled).toBe(true)
  })

  it('onSubmit creates session and calls onSessionCreated', async () => {
    renderWithProviders(
      <AgentHome agent={testAgent} onSessionCreated={onSessionCreated} />
    )

    // Call the onSubmit that was passed to useMessageComposer
    await act(async () => {
      await capturedComposerOptions.onSubmit('Hello agent')
    })

    expect(mockCreateSession.mutateAsync).toHaveBeenCalledWith({
      agentSlug: 'test-agent',
      message: 'Hello agent',
      effort: 'high',
    })
    expect(onSessionCreated).toHaveBeenCalledWith('session-123', 'Hello agent')
  })

  // --- Attachment picker ---

  it('renders attachment picker', () => {
    renderWithProviders(
      <AgentHome agent={testAgent} onSessionCreated={onSessionCreated} />
    )
    expect(screen.getByTitle('Add files')).toBeInTheDocument()
  })

  it('disables attachment picker when disabled', () => {
    mockCreateSession.isPending = true
    renderWithProviders(
      <AgentHome agent={testAgent} onSessionCreated={onSessionCreated} />
    )
    expect(screen.getByTitle('Add files')).toBeDisabled()
  })
})
