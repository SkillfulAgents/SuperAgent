// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, act, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState, type ReactNode } from 'react'
import { AgentHome } from './agent-home'
import { renderWithProviders } from '@renderer/test/test-utils'
import type { ApiAgent } from '@renderer/hooks/use-agents'
import type { AgentHomeAction } from '@renderer/context/nav-transient-context'
import { agentHomeDraftKey, useDraftsStore, type ComposerDraft, type DraftsStore } from '@renderer/context/drafts-context'

// --- Mock data ---

const testAgent: ApiAgent = {
  avatar: { color: 'tonal-blue', shape: 'circle' } as const,
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

// The cards read the page's search; these tests render Agent Home without a router.
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useRouterState: ({ select }: { select: (s: { location: { href: string } }) => unknown }) => select({ location: { href: '/agents/test-agent' } }),
}))
vi.mock('@renderer/context/analytics-context', () => ({
  useAnalyticsTracking: () => ({ track: vi.fn() }),
}))

vi.mock('@renderer/hooks/use-agents', () => ({
  useUpdateAgentAvatar: () => ({ mutate: vi.fn(), isPending: false }),
  useAgent: () => ({ data: { ...testAgent, mounts: [] } }),
  useAgents: () => ({ data: [testAgent] }),
  useRouteAgentId: () => 'test-agent',
  useUpdateAgent: () => ({
    mutate: mockUpdateAgentMutate,
    mutateAsync: mockUpdateAgentMutateAsync,
    isPending: false,
  }),
  useDeleteAgent: () => ({
    mutate: mockDeleteAgentMutate,
    isPending: false,
  }),
  useStartAgent: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
  }),
}))

// Default to "loaded, empty" — most tests don't care. Specific tests that need
// a non-empty list override mockSessionsData before rendering.
let mockSessionsData: unknown = []

vi.mock('@renderer/hooks/use-sessions', () => ({
  // The session list rows now render SessionContextMenu, which reads these.
  useSetSessionMarkedUnread: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useForkSession: () => ({ mutate: vi.fn(), isPending: false }),
  useForkAndCompact: () => ({ mutate: vi.fn(), isPending: false }),
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
      app: { warmStartOnType: true },
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
    useSettings: () => ({ ...settings, isSuccess: true }),
    useModelSettings: () => settings,
    useWarmStartOnTypeEnabled: () => true,
    isWarmStartOnTypeEnabled: () => true,
  }
})

vi.mock('@renderer/hooks/use-scheduled-tasks', () => ({
  useScheduledTasks: () => ({ data: [] }),
  useRunScheduledTaskNow: () => ({ mutate: vi.fn(), isPending: false }),
  useCancelScheduledTask: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useCompletedOneTimeSessions: () => ({ data: [] }),
}))

// The morph one-shots live in NavTransientContext. Controllable so the
// intro-morph test can flip justCreatedSlug and assert the clear.
let mockJustCreatedSlug: string | null = null
const mockSetJustCreatedSlug = vi.fn()
// A parked "Export Agent" / "Agent Directory" from a menu elsewhere. Seeded
// at mount by the hand-off test, which asserts it is consumed.
let mockPendingAgentHomeAction: AgentHomeAction | null = null
const mockSetPendingAgentHomeAction = vi.fn()

vi.mock('@renderer/context/nav-transient-context', () => ({
  useNavTransient: () => ({
    justCreatedSlug: mockJustCreatedSlug,
    setJustCreatedSlug: mockSetJustCreatedSlug,
    pendingAgentHomeAction: mockPendingAgentHomeAction,
    setPendingAgentHomeAction: mockSetPendingAgentHomeAction,
  }),
  NavTransientProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
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
  retryAttachment: vi.fn(),
}

let capturedComposerOptions: any

let homeDrafts: DraftsStore

/** The agent's home draft as something else left it (a stale session's Start Fresh, an earlier visit) before the page mounts. */
function HomeDraftSeeder({ value, children }: { value: ComposerDraft; children: ReactNode }) {
  const store = useDraftsStore()
  useState(() => {
    homeDrafts = store
    store.set(agentHomeDraftKey(testAgent.slug), value)
    return null
  })
  return children
}

// The render-count tests need a message that is real state in whichever component calls the hook, as the real
// hook's is; every other test gets the fixed mockComposer.
let mockComposerStateful = false
let typeIntoComposer: (value: string) => void = () => {}

vi.mock('@renderer/hooks/use-message-composer', () => ({
  useMessageComposer: (opts: any) => {
    capturedComposerOptions = opts
    const [message, setMessage] = useState(mockComposer.message)
    if (!mockComposerStateful) return mockComposer
    typeIntoComposer = setMessage
    return { ...mockComposer, message, setMessage }
  },
}))

// Renders per component, for the tests that pin what a keystroke re-renders: the page and its composer through the
// app's own render tracker, the side panel and the sessions list through pass-through wrappers.
const renderCounts = vi.hoisted(() => ({} as Record<string, number>))
const sidePanelProps = vi.hoisted(() => ({ onRunSkill: undefined as ((skillPath: string) => void) | undefined }))
const creationAidsProps = vi.hoisted(() => ({ onStartVoiceMode: undefined as (() => void) | undefined }))

vi.mock('@renderer/lib/perf', () => ({
  useRenderTracker: (name: string) => {
    renderCounts[name] = (renderCounts[name] ?? 0) + 1
  },
}))
vi.mock('./agent-settings-column', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./agent-settings-column')>()
  return {
    ...actual,
    AgentSettingsColumn: (props: Parameters<typeof actual.AgentSettingsColumn>[0]) => {
      renderCounts.AgentSettingsColumn = (renderCounts.AgentSettingsColumn ?? 0) + 1
      sidePanelProps.onRunSkill = props.onRunSkill
      return <actual.AgentSettingsColumn {...props} />
    },
  }
})
// The voice card is behind a capability the tests do not have; the page's handler for it is what matters here.
vi.mock('@renderer/components/agents/agent-creation-aids', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@renderer/components/agents/agent-creation-aids')>()
  return {
    ...actual,
    AgentCreationAids: (props: Parameters<typeof actual.AgentCreationAids>[0]) => {
      creationAidsProps.onStartVoiceMode = props.onStartVoiceMode
      return <actual.AgentCreationAids {...props} />
    },
  }
})
vi.mock('@renderer/components/sessions/related-sessions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@renderer/components/sessions/related-sessions')>()
  return {
    ...actual,
    RelatedSessions: (props: Parameters<typeof actual.RelatedSessions>[0]) => {
      renderCounts.RelatedSessions = (renderCounts.RelatedSessions ?? 0) + 1
      return <actual.RelatedSessions {...props} />
    },
  }
})

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
    mockComposerStateful = false
    mockRuntimeStatus.data.runtimeReadiness.status = 'READY'
    mockRuntimeStatus.data.apiKeyConfigured = true
    mockRuntimeStatus.isPending = false
    mockCanUseAgent = true
    mockCanAdminAgent = false
    capturedComposerOptions = undefined
    mockSessionsData = []
    mockJustCreatedSlug = null
    mockPendingAgentHomeAction = null
  })

  // --- Rendering ---

  it('renders landing page with agent name', () => {
    renderWithProviders(
      <AgentHome agent={testAgent} onSessionCreated={onSessionCreated} />
    )
    expect(screen.getByText('Test Agent')).toBeInTheDocument()
  })

  it('orders sessions by last activity rather than creation time', () => {
    mockSessionsData = [
      {
        id: 'newer-created',
        agentSlug: testAgent.slug,
        name: 'Newer created session',
        createdAt: new Date('2026-08-25T12:00:00.000Z'),
        lastActivityAt: new Date('2026-08-25T12:00:00.000Z'),
      },
      {
        id: 'recently-active',
        agentSlug: testAgent.slug,
        name: 'Recently active session',
        createdAt: new Date('2026-08-24T12:00:00.000Z'),
        lastActivityAt: new Date('2026-08-26T12:00:00.000Z'),
      },
    ]

    renderWithProviders(
      <AgentHome agent={testAgent} onSessionCreated={onSessionCreated} />
    )

    const sessionRows = screen.getAllByRole('button')
      .filter((row) => row.textContent?.includes('session'))
      .map((row) => row.textContent)

    expect(sessionRows).toEqual([
      expect.stringContaining('Recently active session'),
      expect.stringContaining('Newer created session'),
    ])
  })

  it('stamps each session with its last activity rather than its creation time', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-08-27T12:00:00.000Z'))
      mockSessionsData = [
        {
          id: 'old-but-active',
          agentSlug: testAgent.slug,
          name: 'Old but active session',
          createdAt: new Date('2026-08-17T12:00:00.000Z'),
          lastActivityAt: new Date('2026-08-27T11:00:00.000Z'),
        },
      ]

      renderWithProviders(
        <AgentHome agent={testAgent} onSessionCreated={onSessionCreated} />
      )

      expect(screen.getByText('Old but active session')).toBeInTheDocument()
      expect(screen.getByText('about 1 hour ago')).toBeInTheDocument()
      expect(screen.queryByText('10 days ago')).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives a non-owner the one centred column with no side panel', () => {
    renderWithProviders(
      <AgentHome agent={testAgent} onSessionCreated={onSessionCreated} />
    )

    expect(screen.getByTestId('agent-home-layout')).toHaveClass('mx-auto', 'w-full', 'max-w-[1040px]')
    expect(screen.queryByTestId('agent-home-side-panel')).not.toBeInTheDocument()
  })

  it('always shows an owner the side panel, with no toggle for it', () => {
    mockCanAdminAgent = true
    renderWithProviders(
      <AgentHome agent={testAgent} onSessionCreated={onSessionCreated} />
    )

    expect(screen.getByTestId('agent-home-side-panel')).toContainElement(screen.getByTestId('home-sections-panel'))
    expect(screen.queryByTestId('agent-home-side-panel-toggle')).not.toBeInTheDocument()
  })

  it('reuses the agent context menu on the agent title', () => {
    renderWithProviders(
      <AgentHome agent={testAgent} onSessionCreated={onSessionCreated} />
    )

    const contextMenu = screen.getByTestId('agent-title-context-menu')
    expect(contextMenu).toHaveAttribute('data-agent-slug', 'test-agent')
    expect(contextMenu).toContainElement(screen.getByTestId('agent-name'))
  })

  it('renames the agent from the name and avatar editor for owners', async () => {
    const user = userEvent.setup()
    mockCanAdminAgent = true

    renderWithProviders(
      <AgentHome agent={testAgent} onSessionCreated={onSessionCreated} />
    )

    await user.click(screen.getByTestId('agent-name'))
    expect(screen.getByTestId('agent-identity-preview')).toBeInTheDocument()
    await user.clear(screen.getByTestId('agent-name-input'))
    await user.type(screen.getByTestId('agent-name-input'), 'Renamed Agent{Enter}')

    await waitFor(() => {
      expect(mockUpdateAgentMutate).toHaveBeenCalledWith(
        { slug: 'test-agent', name: 'Renamed Agent' },
        expect.anything(),
      )
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

  it('runs a parked Export Agent only after the composer has taken its mount focus', async () => {
    // "Export Agent" from a menu away from this page parks the action and
    // navigates here. The composer autofocuses on the frame after it mounts,
    // and the Share popover is non-modal, so opening it before that frame let
    // the focus land outside it and dismiss it — the flaky sidebar export.
    mockCanAdminAgent = true
    mockPendingAgentHomeAction = { slug: testAgent.slug, action: 'export' }
    renderWithProviders(<AgentHome agent={testAgent} onSessionCreated={onSessionCreated} />)

    // Consumed at mount, but not opened in the same tick.
    expect(mockSetPendingAgentHomeAction).toHaveBeenCalledWith(null)
    expect(screen.queryByTestId('agent-export-pane')).not.toBeInTheDocument()

    const pane = await screen.findByTestId('agent-export-pane')
    // Let the composer's autofocus frame (and a spare) fire: the popover must
    // still be open, i.e. it opened after that focus rather than before it.
    await act(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    )
    expect(pane).toBeInTheDocument()
  })

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

  it('does not submit on Cmd+Enter when canSubmit is false', async () => {
    const user = userEvent.setup()
    mockComposer.canSubmit = false
    renderWithProviders(
      <AgentHome agent={testAgent} onSessionCreated={onSessionCreated} />
    )

    const input = screen.getByTestId('home-message-input')
    await user.click(input)
    await user.keyboard('{Meta>}{Enter}{/Meta}')

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
    expect(editor.className).toContain('min-h-[40px]')
    expect(editor.style.minHeight).toBe('')

    await user.click(screen.getByRole('button', { name: 'Expand input' }))
    expect(editor.className).toContain('min-h-[50vh]')

    await user.click(screen.getByRole('button', { name: 'Shrink input' }))
    expect(editor.className).toContain('min-h-[40px]')
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
    expect(screen.queryByTestId('agent-identity-trigger')).not.toBeInTheDocument()
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
    expect(capturedComposerOptions.draftKey).toBe('session:agent-home:test-agent')
  })

  it('starts from the options of the session a draft was moved out of, and sends them on the new session', async () => {
    renderWithProviders(
      <HomeDraftSeeder value={{ text: 'Continue', inheritedOptions: { model: 'opus', effort: 'high', speed: 'normal' } }}>
        <AgentHome agent={testAgent} onSessionCreated={onSessionCreated} />
      </HomeDraftSeeder>,
    )

    // Taken by this composer: a later visit starts from the defaults again.
    expect(homeDrafts.get(agentHomeDraftKey(testAgent.slug))).toEqual({ text: 'Continue' })
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

  it('sends a pick left in the home draft, and it is no longer unsent once the session has it', async () => {
    renderWithProviders(
      <HomeDraftSeeder value={{ options: { effort: 'low' } }}>
        <AgentHome agent={testAgent} onSessionCreated={onSessionCreated} />
      </HomeDraftSeeder>,
    )

    await act(() => capturedComposerOptions.onSubmit('Quick question'))
    expect(mockCreateSession.mutateAsync).toHaveBeenCalledWith({
      agentSlug: 'test-agent',
      message: 'Quick question',
      effort: 'low',
    })
    expect(homeDrafts.get(agentHomeDraftKey(testAgent.slug))).toBeUndefined()
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

  // --- The composer's state stops at the composer ---

  describe('composer render boundary', () => {
    const resetRenderCounts = () => {
      for (const name of Object.keys(renderCounts)) delete renderCounts[name]
    }
    const oneSession = [{
      id: 'session-1',
      agentSlug: testAgent.slug,
      name: 'A session',
      createdAt: new Date('2026-08-25T12:00:00.000Z'),
      lastActivityAt: new Date('2026-08-25T12:00:00.000Z'),
    }]

    it('typing re-renders the composer, not the page, its side panel or its sessions', () => {
      mockComposerStateful = true
      mockCanAdminAgent = true
      mockSessionsData = oneSession
      renderWithProviders(
        <AgentHome agent={testAgent} onSessionCreated={onSessionCreated} />
      )
      // Both are on the page, so a count of zero below means "not re-rendered", not "not there".
      expect(renderCounts.AgentSettingsColumn).toBeGreaterThan(0)
      expect(renderCounts.RelatedSessions).toBeGreaterThan(0)
      resetRenderCounts()

      // Twenty keystrokes, each its own update, as the editor's onChange delivers them.
      const text = 'summarise the inbox!'
      expect(text).toHaveLength(20)
      for (let i = 1; i <= text.length; i++) {
        act(() => typeIntoComposer(text.slice(0, i)))
      }

      expect(screen.getByTestId('home-message-input')).toHaveTextContent(text)
      expect(renderCounts.AgentHomeComposer).toBeGreaterThanOrEqual(20)
      expect(renderCounts.AgentHome ?? 0).toBe(0)
      expect(renderCounts.AgentSettingsColumn ?? 0).toBe(0)
      expect(renderCounts.RelatedSessions ?? 0).toBe(0)
    })

    it('the typewriter placeholder of a new agent ticks in the composer, not the page', () => {
      const originalMatchMedia = window.matchMedia
      window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as typeof window.matchMedia
      vi.useFakeTimers()
      try {
        mockCanAdminAgent = true
        renderWithProviders(
          <AgentHome agent={{ ...testAgent, name: 'Untitled' }} onSessionCreated={onSessionCreated} />
        )
        expect(renderCounts.AgentSettingsColumn).toBeGreaterThan(0)
        resetRenderCounts()

        // Two idle seconds: the placeholder types a character every 25 ms. One act per tick, as each timer is its
        // own task in a browser; a single act would batch all eighty into one render.
        for (let elapsed = 0; elapsed < 2000; elapsed += 25) {
          act(() => { vi.advanceTimersByTime(25) })
        }

        expect(renderCounts.AgentHomeComposer).toBeGreaterThanOrEqual(40)
        expect(renderCounts.AgentHome ?? 0).toBe(0)
        expect(renderCounts.AgentSettingsColumn ?? 0).toBe(0)
      } finally {
        vi.useRealTimers()
        window.matchMedia = originalMatchMedia
      }
    })

    it('running a skill from the side panel still writes its command into the composer and focuses it', async () => {
      mockComposerStateful = true
      mockCanAdminAgent = true
      renderWithProviders(
        <AgentHome agent={testAgent} onSessionCreated={onSessionCreated} />
      )
      const input = screen.getByTestId('home-message-input')
      input.scrollIntoView = vi.fn()
      input.blur()

      act(() => sidePanelProps.onRunSkill?.('weekly-report'))

      expect(input).toHaveTextContent('/weekly-report')
      expect(input.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' })
      await waitFor(() => expect(input).toHaveFocus())
    })

    it('the empty-state voice card still starts a voice session through the composer', async () => {
      renderWithProviders(
        <AgentHome agent={testAgent} onSessionCreated={onSessionCreated} />
      )

      act(() => creationAidsProps.onStartVoiceMode?.())

      await waitFor(() => {
        expect(onSessionCreated).toHaveBeenCalledWith('session-123', expect.any(String), 'srv-msg-uuid', { voiceMode: true })
      })
      expect(mockCreateSession.mutateAsync.mock.calls[0][0]).toMatchObject({ agentSlug: 'test-agent', inputMode: 'voice' })
    })
  })

})
