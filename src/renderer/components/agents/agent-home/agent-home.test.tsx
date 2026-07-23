// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, act, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState, type ReactNode } from 'react'
import { AgentHome } from './agent-home'
import { renderWithProviders } from '@renderer/test/test-utils'
import type { ApiAgent } from '@renderer/hooks/use-agents'
import { useDraftsStore } from '@renderer/context/drafts-context'
import {
  newSessionCarryoverKey,
  type NewSessionCarryover,
} from '@renderer/lib/new-session-carryover'

// --- Mock data ---

const testAgent: ApiAgent = {
  slug: 'test-agent',
  displaySlug: 'test-agent',
  name: 'Test Agent',
  description: 'A test agent',
  createdAt: new Date('2025-01-01'),
  status: 'running',
  containerPort: 3000,
}

// --- Mocks ---

const mockCreateSession = {
  mutateAsync: vi.fn().mockResolvedValue({ id: 'session-123', initialMessageUuid: 'srv-msg-uuid' }),
  isPending: false,
}

const mockUpdateAgentMutate = vi.fn()
const mockUpdateAgentMutateAsync = vi.fn()
const mockDeleteAgentMutate = vi.fn()

vi.mock('@renderer/hooks/use-agents', () => ({
  useAgent: () => ({ data: { ...testAgent, mounts: [] } }),
  useAgents: () => ({ data: [testAgent] }),
  useUpdateAgent: () => ({
    mutate: mockUpdateAgentMutate,
    mutateAsync: mockUpdateAgentMutateAsync,
    isPending: false,
  }),
  useDeleteAgent: () => ({
    mutate: mockDeleteAgentMutate,
    isPending: false,
  }),
}))

// Default to "loaded, empty" — most tests don't care. Specific tests that need
// a non-empty list override mockSessionsData before rendering.
let mockSessionsData: unknown = []

vi.mock('@renderer/hooks/use-sessions', () => ({
  useCreateSession: () => mockCreateSession,
  useSessions: () => ({ data: mockSessionsData }),
  useDeleteSession: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useSession: () => ({ data: undefined }),
  useUpdateSessionName: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
}))

// Settings drive ComposerOptions: the catalog comes from llmProviderStatus,
// fallback model from settings.models.agentModel. The pickers read the
// non-admin useModelSettings; useSettings stays for any admin-only consumers.
vi.mock('@renderer/hooks/use-settings', () => {
  const settings = {
    data: {
      llmProvider: 'anthropic',
      models: { agentModel: 'sonnet' },
      llmProviderStatus: [
        {
          id: 'anthropic',
          name: 'Anthropic',
          isConfigured: true,
          catalog: [
            { id: 'claude-opus-4-8', label: 'Opus 4.8', family: 'opus', isLatest: true, icon: 'anthropic', supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
            { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', family: 'sonnet', isLatest: true, icon: 'anthropic', supportedEfforts: ['low', 'medium', 'high'] },
            { id: 'claude-haiku-4-5', label: 'Haiku 4.5', family: 'haiku', isLatest: true, icon: 'anthropic', supportedEfforts: ['low', 'medium', 'high'] },
          ],
          defaultModels: { agent: 'opus', summarizer: 'haiku', browser: 'sonnet' },
        },
      ],
    },
  }
  return {
    useSettings: () => settings,
    useModelSettings: () => settings,
  }
})

vi.mock('@renderer/hooks/use-scheduled-tasks', () => ({
  useScheduledTasks: () => ({ data: [] }),
  useRunScheduledTaskNow: () => ({ mutate: vi.fn(), isPending: false }),
  useCancelScheduledTask: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
}))

// The morph one-shots live in NavTransientContext. Controllable so the
// intro-morph test can flip justCreatedSlug and assert the clear.
let mockJustCreatedSlug: string | null = null
const mockSetJustCreatedSlug = vi.fn()

vi.mock('@renderer/context/nav-transient-context', () => ({
  useNavTransient: () => ({
    justCreatedSlug: mockJustCreatedSlug,
    setJustCreatedSlug: mockSetJustCreatedSlug,
  }),
  NavTransientProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

// The agent-scoped settings dialogs render inside AgentHome. Stub them
// — their internals aren't under test here and would pull in extra hooks.
vi.mock('@renderer/components/agents/agent-settings-dialog', () => ({
  AgentSettingsDialog: () => null,
}))
vi.mock('@renderer/components/agents/agent-context-menu', () => ({
  AgentContextMenu: ({ agent, children }: { agent: ApiAgent; children: React.ReactNode }) => (
    <div data-testid="agent-title-context-menu" data-agent-slug={agent.slug}>{children}</div>
  ),
}))
vi.mock('@renderer/components/agents/system-prompt-dialog', () => ({
  SystemPromptDialog: () => null,
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

function CarryoverSeeder({ value, children }: { value: NewSessionCarryover; children: ReactNode }) {
  const store = useDraftsStore()
  useState(() => {
    store.set(newSessionCarryoverKey(testAgent.slug), value)
    return null
  })
  return children
}

vi.mock('@renderer/hooks/use-message-composer', () => ({
  useMessageComposer: (opts: any) => {
    capturedComposerOptions = opts
    return mockComposer
  },
}))

vi.mock('@renderer/hooks/use-start-onboarding-session', () => ({
  useStartOnboardingSession: () => vi.fn(),
}))

vi.mock('@renderer/hooks/use-humanized-cron', () => ({
  useHumanizedCron: () => null,
}))

vi.mock('@renderer/hooks/use-agent-skills', () => ({
  useAgentSkills: () => ({ data: [] }),
  useDiscoverableSkills: () => ({ data: [] }),
  useRefreshAgentSkills: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateSkill: () => ({ mutate: vi.fn(), isPending: false }),
  useExportSkill: () => ({ mutate: vi.fn(), isPending: false }),
  useImportSkillZip: () => ({ mutateAsync: vi.fn(), isPending: false }),
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
    mockCreateSession.mutateAsync.mockResolvedValue({ id: 'session-123', initialMessageUuid: 'srv-msg-uuid' })
    mockUpdateAgentMutateAsync.mockResolvedValue({ ...testAgent })
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
    mockSessionsData = []
    mockJustCreatedSlug = null
  })

  // --- Rendering ---

  it('renders landing page with agent name', () => {
    renderWithProviders(
      <AgentHome agent={testAgent} onSessionCreated={onSessionCreated} />
    )
    expect(screen.getByText('Test Agent')).toBeInTheDocument()
  })

  it('keeps the non-owner layout full-width below the desktop breakpoint', () => {
    renderWithProviders(
      <AgentHome agent={testAgent} onSessionCreated={onSessionCreated} />
    )

    const layout = screen.getByTestId('agent-home-layout')
    expect(layout).toHaveClass('w-full', 'xl:max-w-2xl')
    expect(layout).not.toHaveClass('max-w-2xl')
  })

  it('reuses the agent context menu on the agent title', () => {
    renderWithProviders(
      <AgentHome agent={testAgent} onSessionCreated={onSessionCreated} />
    )

    const contextMenu = screen.getByTestId('agent-title-context-menu')
    expect(contextMenu).toHaveAttribute('data-agent-slug', 'test-agent')
    expect(contextMenu).toContainElement(screen.getByTestId('agent-name'))
  })

  it('renames the agent inline for owners', async () => {
    const user = userEvent.setup()
    mockCanAdminAgent = true

    renderWithProviders(
      <AgentHome agent={testAgent} onSessionCreated={onSessionCreated} />
    )

    await user.click(screen.getByTestId('agent-name'))
    await user.clear(screen.getByTestId('agent-name-input'))
    await user.type(screen.getByTestId('agent-name-input'), 'Renamed Agent')
    await user.click(screen.getByTestId('agent-name-save'))

    await waitFor(() => {
      expect(mockUpdateAgentMutateAsync).toHaveBeenCalledWith({
        slug: 'test-agent',
        name: 'Renamed Agent',
      })
    })
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

  // --- New-agent intro morph ---

  it('plays the new-agent intro morph once when justCreatedSlug matches, then clears the tag', () => {
    // jsdom lacks matchMedia; the morph reads prefers-reduced-motion and
    // useIsMobile() subscribes via addEventListener, so include the listeners.
    const originalMatchMedia = window.matchMedia
    window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as typeof window.matchMedia
    vi.useFakeTimers()
    try {
      mockJustCreatedSlug = testAgent.slug
      const { unmount } = renderWithProviders(
        <AgentHome agent={testAgent} onSessionCreated={onSessionCreated} />
      )
      // The intro overlay is showing.
      expect(screen.getByText('Creating')).toBeInTheDocument()
      // After the intro window the one-shot tag is cleared so it can't replay.
      act(() => { vi.advanceTimersByTime(2200) })
      expect(mockSetJustCreatedSlug).toHaveBeenCalledWith(null)
      unmount()

      // A second mount with the tag cleared does NOT replay the morph.
      mockJustCreatedSlug = null
      renderWithProviders(
        <AgentHome agent={testAgent} onSessionCreated={onSessionCreated} />
      )
      expect(screen.queryByText('Creating')).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
      window.matchMedia = originalMatchMedia
    }
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
    expect(screen.getByTestId('home-message-input')).toHaveAttribute('aria-disabled', 'true')
  })

  it('disables input when createSession is pending', () => {
    mockCreateSession.isPending = true
    renderWithProviders(
      <AgentHome agent={testAgent} onSessionCreated={onSessionCreated} />
    )
    expect(screen.getByTestId('home-message-input')).toHaveAttribute('aria-disabled', 'true')
  })

  it('disables input when uploading', () => {
    mockComposer.isUploading = true
    renderWithProviders(
      <AgentHome agent={testAgent} onSessionCreated={onSessionCreated} />
    )
    expect(screen.getByTestId('home-message-input')).toHaveAttribute('aria-disabled', 'true')
  })

  // --- Auto-expand ---

  it('expands and shrinks the editor with the input-size toggle', async () => {
    const user = userEvent.setup()
    renderWithProviders(
      <AgentHome agent={testAgent} onSessionCreated={onSessionCreated} />
    )

    const editor = screen.getByTestId('home-message-input')
    expect(editor.className).toContain('min-h-[60px]')
    expect(editor.style.minHeight).toBe('')

    await user.click(screen.getByRole('button', { name: 'Expand input' }))
    expect(editor.className).toContain('min-h-[50vh]')

    await user.click(screen.getByRole('button', { name: 'Shrink input' }))
    expect(editor.className).toContain('min-h-[60px]')
  })

  it('auto-expands to full view when the editor overflows its max-height', async () => {
    // jsdom doesn't compute layout, so stub scrollHeight > clientHeight to
    // simulate content overflowing the CSS-driven 6-line cap.
    const origScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight')
    const origClient = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => 200 })
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 120 })
    try {
      mockComposer.message = 'this message would overflow six lines in a real browser'
      renderWithProviders(
        <AgentHome agent={testAgent} onSessionCreated={onSessionCreated} />
      )

      await waitFor(() => {
        expect(screen.getByTestId('home-message-input').className).toContain('min-h-[50vh]')
      })
    } finally {
      if (origScroll) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', origScroll)
      if (origClient) Object.defineProperty(HTMLElement.prototype, 'clientHeight', origClient)
    }
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

  it('hydrates a carried composer and sends its model and effort on the new session', async () => {
    const attachment = {
      type: 'file' as const,
      id: 'file-1',
      file: new File(['hello'], 'hello.txt', { type: 'text/plain' }),
    }
    renderWithProviders(
      <CarryoverSeeder value={{ attachments: [attachment], model: 'opus', effort: 'high', speed: 'normal' }}>
        <AgentHome agent={testAgent} onSessionCreated={onSessionCreated} />
      </CarryoverSeeder>,
    )

    expect(capturedComposerOptions.initialAttachments).toEqual([attachment])
    await act(() => capturedComposerOptions.onSubmit('Continue in a new session'))
    expect(mockCreateSession.mutateAsync).toHaveBeenCalledWith({
      agentSlug: 'test-agent',
      message: 'Continue in a new session',
      model: 'opus',
      effort: 'high',
      // A carried speed is an explicit (session-seeded) value, so it rides along.
      speed: 'normal',
    })
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

    expect(mockCreateSession.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        agentSlug: 'test-agent',
        message: 'Hello agent',
      })
    )
    // Untouched composer: model/effort omitted so the server resolves
    // agent-default > global instead of receiving the display echo as a pick.
    expect(mockCreateSession.mutateAsync.mock.calls[0][0]).not.toHaveProperty('effort')
    expect(mockCreateSession.mutateAsync.mock.calls[0][0]).not.toHaveProperty('model')
    // The uuid is server-assigned: never sent in the request, and the one
    // from the response is forwarded to onSessionCreated.
    expect(mockCreateSession.mutateAsync.mock.calls[0][0]).not.toHaveProperty('messageUuid')
    expect(onSessionCreated).toHaveBeenCalledWith('session-123', 'Hello agent', 'srv-msg-uuid')
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
