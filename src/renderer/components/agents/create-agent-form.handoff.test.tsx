// @vitest-environment jsdom

import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DraftsProvider } from '@renderer/context/drafts-context'
import type { SignupHandoff } from '@renderer/context/nav-transient-context'
import { DEFAULT_PUBLIC_SKILLSET } from '@shared/lib/skillset-provider/default-public-skillset'
import type { ApiDiscoverableAgent } from '@shared/lib/types/api'

const mockCreateSession = vi.fn()
const mockCreateAgent = vi.fn()
const mockStartAgent = vi.fn()
const mockSetSignupHandoff = vi.fn()
let mockSignupHandoff: SignupHandoff | null = null
let mockWarmStartEnabled = false
let mockDiscoverableAgents: ApiDiscoverableAgent[] | undefined = []
let mockDiscoverableAgentsFailed = false
let lastDialogProps: { template: unknown; handoffOrigin?: boolean } | null = null
let latestTranscriptUpdate: ((text: string) => void) | null = null
let lastComposerAutoFocus: boolean | undefined
let mockAgentModel = 'opus'
// The model popover reads icon/supportedEfforts unconditionally, and the
// override test needs a second model inside one vendor tab to pick.
const EFFORTS = ['low', 'medium', 'high']
const catalogFixture = () => [
  { id: 'claude-opus-5', family: 'opus', label: 'Opus 5', isLatest: true, icon: 'anthropic', supportedEfforts: EFFORTS },
  { id: 'claude-sonnet-4-6', family: 'sonnet', label: 'Sonnet 4.6', isLatest: true, icon: 'anthropic', supportedEfforts: EFFORTS },
  { id: 'kimi-k3', family: 'kimi', label: 'Kimi K3', isLatest: true, icon: 'kimi', supportedEfforts: EFFORTS },
]
let mockCatalog = catalogFixture()

vi.mock('@renderer/context/nav-transient-context', () => ({
  useNavTransient: () => ({
    justCreatedSlug: null,
    setJustCreatedSlug: vi.fn(),
    get signupHandoff() {
      return mockSignupHandoff
    },
    setSignupHandoff: (value: SignupHandoff | null) => {
      mockSignupHandoff = value
      mockSetSignupHandoff(value)
    },
  }),
}))

vi.mock('@renderer/hooks/use-settings', () => ({
  useModelSettings: () => ({
    data: {
      llmProvider: 'anthropic',
      models: { agentModel: mockAgentModel },
      llmProviderStatus: [{
        id: 'anthropic',
        catalog: mockCatalog,
        defaultModels: { agent: 'opus', summarizer: 'haiku', browser: 'sonnet' },
      }],
    },
  }),
  useWarmStartOnTypeEnabled: () => mockWarmStartEnabled,
}))

vi.mock('@renderer/hooks/use-runtime-status', () => ({
  useRuntimeStatus: () => ({
    data: { runtimeReadiness: { status: 'READY' } },
  }),
}))

vi.mock('@renderer/hooks/use-start-onboarding-session', () => ({
  useStartOnboardingSession: () => vi.fn(),
}))

vi.mock('@renderer/hooks/use-agents', () => ({
  useCreateAgent: () => ({
    mutateAsync: mockCreateAgent,
    isPending: false,
  }),
  useUpdateAgent: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useDeleteAgent: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useStartAgent: () => ({
    mutate: mockStartAgent,
    mutateAsync: vi.fn(),
    isPending: false,
  }),
}))

vi.mock('@renderer/hooks/use-sessions', () => ({
  useCreateSession: () => ({
    mutateAsync: mockCreateSession,
    isPending: false,
  }),
}))

vi.mock('@renderer/lib/derive-agent-name', () => ({
  deriveAgentName: vi.fn(async () => 'Test Agent'),
}))

vi.mock('@renderer/hooks/use-typewriter-placeholder', () => ({
  useTypewriterPlaceholder: () => 'placeholder',
  DEFAULT_AGENT_PROMPT_EXAMPLES: [],
}))

vi.mock('@renderer/components/agents/agent-creation-aids', () => ({
  AgentCreationAids: ({ onAidOpened }: { onAidOpened?: () => void }) => (
    <button type="button" data-testid="aid-opened" onClick={() => onAidOpened?.()}>
      aid
    </button>
  ),
}))

vi.mock('@renderer/hooks/use-agent-templates', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@renderer/hooks/use-agent-templates')>()
  return {
    ...actual,
    useDiscoverableAgents: () => ({
      data: mockDiscoverableAgents,
      isError: mockDiscoverableAgentsFailed,
    }),
  }
})

vi.mock('@renderer/hooks/use-voice-input', () => ({
  useVoiceInput: ({ onTranscriptUpdate }: { onTranscriptUpdate: (text: string) => void }) => {
    latestTranscriptUpdate = onTranscriptUpdate
    return {
      state: 'idle',
      isRecording: false,
      isConnecting: false,
      isFinalizing: false,
      error: null,
      clearError: vi.fn(),
      isSupported: true,
      analyserRef: { current: null },
      startRecording: vi.fn(),
      stopRecording: vi.fn(),
    }
  },
}))

vi.mock('@renderer/components/agents/template-install-dialog', () => ({
  TemplateInstallDialog: (props: { template: unknown; handoffOrigin?: boolean }) => {
    lastDialogProps = props
    return props.template ? <div data-testid="template-install-dialog" /> : null
  },
}))

vi.mock('@renderer/components/ui/attachment-picker', () => ({
  AttachmentPicker: () => null,
}))

vi.mock('@renderer/components/ui/voice-input-button', () => ({
  VoiceInputButton: () => null,
  VoiceInputError: () => null,
}))

vi.mock('@renderer/components/messages/chat-composer-box', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@renderer/components/messages/chat-composer-box')>()
  return {
    ChatComposerBox: (props: Parameters<typeof actual.ChatComposerBox>[0]) => {
      lastComposerAutoFocus = props.autoFocus
      return actual.ChatComposerBox(props)
    },
  }
})

import { CreateAgentForm } from './create-agent-form'

function discoverable(slug: string, skillsetId: string = DEFAULT_PUBLIC_SKILLSET.id): ApiDiscoverableAgent {
  return {
    skillsetId,
    skillsetName: 'Public',
    name: `Template ${slug}`,
    description: '',
    version: '1.0.0',
    path: `agents/${slug}/`,
  }
}

function renderForm() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <DraftsProvider>
        <CreateAgentForm />
      </DraftsProvider>
    </QueryClientProvider>,
  )
}

describe('CreateAgentForm signup handoff', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSignupHandoff = null
    mockWarmStartEnabled = false
    mockDiscoverableAgents = []
    mockDiscoverableAgentsFailed = false
    latestTranscriptUpdate = null
    lastComposerAutoFocus = undefined
    lastDialogProps = null
    mockCatalog = catalogFixture()
    mockAgentModel = 'opus'
    mockCreateAgent.mockResolvedValue({
      slug: 'agent-1',
      displaySlug: 'agent-1',
      name: 'Test Agent',
    })
    mockCreateSession.mockResolvedValue({ id: 'session-1' })
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0)
      return 0
    })
    vi.stubGlobal('cancelAnimationFrame', () => {})
  })

  it('seeds the composer, clears the one-shot, and submits with a catalog model', async () => {
    mockSignupHandoff = { prompt: 'hello', model: 'claude-opus-5' }
    const user = userEvent.setup()
    renderForm()

    await waitFor(() => {
      expect(screen.getByTestId('create-agent-prompt')).toHaveTextContent('hello')
    })
    expect(mockSetSignupHandoff).toHaveBeenCalledWith(null)
    await user.click(screen.getByTestId('create-agent-submit'))

    await waitFor(() => {
      expect(mockCreateSession).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'claude-opus-5' }),
      )
    })
  })

  it('falls back to the global default when the carried model is unknown', async () => {
    mockSignupHandoff = { prompt: 'hello', model: 'kimi-k2' }
    const user = userEvent.setup()
    renderForm()

    await waitFor(() => {
      expect(screen.getByTestId('create-agent-prompt')).toHaveTextContent('hello')
    })
    await user.click(screen.getByTestId('create-agent-submit'))

    await waitFor(() => {
      expect(mockCreateSession).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'opus' }),
      )
    })
  })

  it('uses the global default when there is no handoff', async () => {
    const user = userEvent.setup()
    renderForm()

    const prompt = screen.getByTestId('create-agent-prompt')
    await user.click(prompt)
    await user.keyboard('from scratch')
    await user.click(screen.getByTestId('create-agent-submit'))

    await waitFor(() => {
      expect(mockCreateSession).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'opus', message: 'from scratch' }),
      )
    })
    expect(mockSetSignupHandoff).not.toHaveBeenCalled()
  })

  it('does not hard-code Opus above a different global default', async () => {
    mockAgentModel = 'sonnet'
    const user = userEvent.setup()
    renderForm()

    const prompt = screen.getByTestId('create-agent-prompt')
    await user.click(prompt)
    await user.keyboard('from scratch')
    await user.click(screen.getByTestId('create-agent-submit'))

    await waitFor(() => {
      expect(mockCreateSession).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'sonnet', message: 'from scratch' }),
      )
    })
  })

  it('seeds the model picker from the carried model', async () => {
    mockSignupHandoff = { prompt: 'hello', model: 'claude-sonnet-4-6' }
    const user = userEvent.setup()
    renderForm()

    await waitFor(() => {
      expect(screen.getByTestId('composer-options-trigger')).toHaveTextContent('Sonnet 4.6')
    })
    await user.click(screen.getByTestId('create-agent-submit'))

    await waitFor(() => {
      expect(mockCreateSession).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'claude-sonnet-4-6' }),
      )
    })
  })

  it('submits the picked model when the user overrides the carried one', async () => {
    mockSignupHandoff = { prompt: 'hello', model: 'claude-opus-5' }
    const user = userEvent.setup()
    renderForm()

    await waitFor(() => {
      expect(screen.getByTestId('composer-options-trigger')).toHaveTextContent('Opus 5')
    })
    await user.click(screen.getByTestId('composer-options-trigger'))
    await user.click(await screen.findByTestId('model-pinned-claude-sonnet-4-6'))
    await waitFor(() => {
      expect(screen.getByTestId('composer-options-trigger')).toHaveTextContent('Sonnet 4.6')
    })
    await user.keyboard('{Escape}')
    await user.click(screen.getByTestId('create-agent-submit'))

    await waitFor(() => {
      expect(mockCreateSession).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'claude-sonnet-4-6' }),
      )
    })
  })

  it('shows the default model in the picker when the carried model is unknown', async () => {
    mockSignupHandoff = { prompt: 'hello', model: 'kimi-k2' }
    renderForm()

    await waitFor(() => {
      expect(screen.getByTestId('create-agent-prompt')).toHaveTextContent('hello')
    })
    // The global 'opus' alias resolves through the catalog to its latest for display.
    expect(screen.getByTestId('composer-options-trigger')).toHaveTextContent('Opus 5')
  })

  it('row5: prefill with warm-start enabled does not create an agent until edit', async () => {
    mockWarmStartEnabled = true
    mockSignupHandoff = { prompt: 'marketing prompt', model: 'claude-opus-5' }
    renderForm()

    await waitFor(() => {
      expect(screen.getByTestId('create-agent-prompt')).toHaveTextContent('marketing prompt')
    })
    // Allow warm-start effect to run if it were going to.
    await new Promise((r) => setTimeout(r, 50))
    expect(mockCreateAgent).not.toHaveBeenCalled()
    expect(mockStartAgent).not.toHaveBeenCalled()
  })

  it('opens install dialog with matched public template and handoffOrigin', async () => {
    mockDiscoverableAgents = [discoverable('research-bot')]
    mockSignupHandoff = { template_slug: 'research-bot' }
    renderForm()

    await waitFor(() => {
      expect(screen.getByTestId('template-install-dialog')).toBeTruthy()
    })
    expect(lastDialogProps?.handoffOrigin).toBe(true)
    expect(lastDialogProps?.template).toEqual(discoverable('research-bot'))
  })

  it('suppresses composer autoFocus when a template slug is armed on mount', () => {
    mockDiscoverableAgents = []
    mockSignupHandoff = { template_slug: 'focus-bot' }
    renderForm()
    expect(lastComposerAutoFocus).toBe(false)
  })

  it('matches only the public skillset when paths collide', async () => {
    mockDiscoverableAgents = [
      discoverable('same-slug', 'private-skillset'),
      discoverable('same-slug', DEFAULT_PUBLIC_SKILLSET.id),
    ]
    mockSignupHandoff = { template_slug: 'same-slug' }
    renderForm()

    await waitFor(() => {
      expect(screen.getByTestId('template-install-dialog')).toBeTruthy()
    })
    expect((lastDialogProps?.template as ApiDiscoverableAgent).skillsetId).toBe(
      DEFAULT_PUBLIC_SKILLSET.id,
    )
  })

  // The armed slug suppresses the editor's create-once autoFocus. Any path that
  // disarms without opening the dialog owes the user focus back, or the create box
  // sits dead until they click it.
  it('hands focus back to the composer when the list settles with no match', async () => {
    mockDiscoverableAgents = [discoverable('other')]
    mockSignupHandoff = { template_slug: 'missing-slug' }
    renderForm()

    await waitFor(() => {
      expect(screen.getByTestId('create-agent-prompt')).toHaveFocus()
    })
  })

  it('hands focus back to the composer when the discoverable query errors', async () => {
    mockDiscoverableAgents = undefined
    mockDiscoverableAgentsFailed = true
    mockSignupHandoff = { template_slug: 'error-bot' }
    renderForm()

    await waitFor(() => {
      expect(screen.getByTestId('create-agent-prompt')).toHaveFocus()
    })
  })

  // useDiscoverableAgents is `enabled: hasSkillsets` — with no skillsets the query
  // never runs, so data stays undefined and isError stays false forever. Without a
  // bounded wait the offer stays armed and the composer never gets focus.
  it('settles after the bounded wait when the list never arrives', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      mockDiscoverableAgents = []
      mockSignupHandoff = { template_slug: 'stranded-bot' }
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      })
      const view = render(
        <QueryClientProvider client={queryClient}>
          <DraftsProvider>
            <CreateAgentForm />
          </DraftsProvider>
        </QueryClientProvider>,
      )
      expect(lastComposerAutoFocus).toBe(false)
      expect(screen.getByTestId('create-agent-prompt')).not.toHaveFocus()

      // Still armed well past a cold sync. Probe autoFocus, not focus itself:
      // clearing the slug flips this prop in the same commit, whereas the focus
      // call lands in a nested 0ms timer that a single advance does not drain.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000)
      })
      expect(lastComposerAutoFocus).toBe(false)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(6000)
      })
      expect(screen.getByTestId('create-agent-prompt')).toHaveFocus()

      // Settled for good — a list that shows up afterwards must not pop the offer.
      mockDiscoverableAgents = [discoverable('stranded-bot')]
      view.rerender(
        <QueryClientProvider client={queryClient}>
          <DraftsProvider>
            <CreateAgentForm />
          </DraftsProvider>
        </QueryClientProvider>,
      )
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100)
      })
      expect(screen.queryByTestId('template-install-dialog')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('settle clears slug permanently when populated list has no match', async () => {
    mockDiscoverableAgents = [discoverable('other')]
    mockSignupHandoff = { template_slug: 'missing-slug' }
    const view = renderForm()

    await waitFor(() => {
      expect(screen.queryByTestId('template-install-dialog')).toBeNull()
    })

    mockDiscoverableAgents = [discoverable('missing-slug')]
    view.rerender(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <DraftsProvider>
          <CreateAgentForm />
        </DraftsProvider>
      </QueryClientProvider>,
    )

    await new Promise((r) => setTimeout(r, 50))
    expect(screen.queryByTestId('template-install-dialog')).toBeNull()
  })

  it('waits on empty discoverable list then opens when a match arrives', async () => {
    mockDiscoverableAgents = []
    mockSignupHandoff = { template_slug: 'late-bot' }
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    const view = render(
      <QueryClientProvider client={queryClient}>
        <DraftsProvider>
          <CreateAgentForm />
        </DraftsProvider>
      </QueryClientProvider>,
    )

    await new Promise((r) => setTimeout(r, 50))
    expect(screen.queryByTestId('template-install-dialog')).toBeNull()

    mockDiscoverableAgents = [discoverable('late-bot')]
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <DraftsProvider>
          <CreateAgentForm />
        </DraftsProvider>
      </QueryClientProvider>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('template-install-dialog')).toBeTruthy()
    })
  })

  it('typing in the composer forfeits template handoff including type-then-delete', async () => {
    mockDiscoverableAgents = []
    mockSignupHandoff = { template_slug: 'forfeit-bot' }
    const user = userEvent.setup()
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    const view = render(
      <QueryClientProvider client={queryClient}>
        <DraftsProvider>
          <CreateAgentForm />
        </DraftsProvider>
      </QueryClientProvider>,
    )

    const prompt = screen.getByTestId('create-agent-prompt')
    await user.click(prompt)
    await user.keyboard('x')
    await user.keyboard('{Backspace}')

    mockDiscoverableAgents = [discoverable('forfeit-bot')]
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <DraftsProvider>
          <CreateAgentForm />
        </DraftsProvider>
      </QueryClientProvider>,
    )

    await new Promise((r) => setTimeout(r, 50))
    expect(screen.queryByTestId('template-install-dialog')).toBeNull()
  })

  it('prompt plus slug seeds composer and never opens install dialog', async () => {
    mockDiscoverableAgents = [discoverable('ignored-bot')]
    mockSignupHandoff = { prompt: 'from marketing', template_slug: 'ignored-bot' }
    renderForm()

    await waitFor(() => {
      expect(screen.getByTestId('create-agent-prompt')).toHaveTextContent('from marketing')
    })
    expect(screen.queryByTestId('template-install-dialog')).toBeNull()
  })

  it('settles when the populated list only has a private skillset twin', async () => {
    mockDiscoverableAgents = [discoverable('private-only', 'private-skillset')]
    mockSignupHandoff = { template_slug: 'private-only' }
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    const view = render(
      <QueryClientProvider client={queryClient}>
        <DraftsProvider>
          <CreateAgentForm />
        </DraftsProvider>
      </QueryClientProvider>,
    )

    await waitFor(() => {
      expect(screen.queryByTestId('template-install-dialog')).toBeNull()
    })

    mockDiscoverableAgents = [
      discoverable('private-only', 'private-skillset'),
      discoverable('private-only', DEFAULT_PUBLIC_SKILLSET.id),
    ]
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <DraftsProvider>
          <CreateAgentForm />
        </DraftsProvider>
      </QueryClientProvider>,
    )

    await new Promise((r) => setTimeout(r, 50))
    expect(screen.queryByTestId('template-install-dialog')).toBeNull()
  })

  it('model plus slug still opens the install offer', async () => {
    mockDiscoverableAgents = [discoverable('model-bot')]
    mockSignupHandoff = { model: 'claude-opus-5', template_slug: 'model-bot' }
    renderForm()

    await waitFor(() => {
      expect(screen.getByTestId('template-install-dialog')).toBeTruthy()
    })
    expect(lastDialogProps?.handoffOrigin).toBe(true)
  })

  it('opening a creation aid forfeits before a late match can open the dialog', async () => {
    mockDiscoverableAgents = []
    mockSignupHandoff = { template_slug: 'aid-bot' }
    const user = userEvent.setup()
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    const view = render(
      <QueryClientProvider client={queryClient}>
        <DraftsProvider>
          <CreateAgentForm />
        </DraftsProvider>
      </QueryClientProvider>,
    )

    await user.click(screen.getByTestId('aid-opened'))

    mockDiscoverableAgents = [discoverable('aid-bot')]
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <DraftsProvider>
          <CreateAgentForm />
        </DraftsProvider>
      </QueryClientProvider>,
    )

    await new Promise((r) => setTimeout(r, 50))
    expect(screen.queryByTestId('template-install-dialog')).toBeNull()
  })

  it('composer mic transcript forfeits template handoff', async () => {
    mockDiscoverableAgents = []
    mockSignupHandoff = { template_slug: 'voice-bot' }
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    const view = render(
      <QueryClientProvider client={queryClient}>
        <DraftsProvider>
          <CreateAgentForm />
        </DraftsProvider>
      </QueryClientProvider>,
    )

    await waitFor(() => {
      expect(latestTranscriptUpdate).toBeTypeOf('function')
    })
    act(() => {
      latestTranscriptUpdate?.('spoken prompt')
    })

    mockDiscoverableAgents = [discoverable('voice-bot')]
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <DraftsProvider>
          <CreateAgentForm />
        </DraftsProvider>
      </QueryClientProvider>,
    )

    await new Promise((r) => setTimeout(r, 50))
    expect(screen.queryByTestId('template-install-dialog')).toBeNull()
  })

  it('discoverable query error clears the template offer', async () => {
    mockDiscoverableAgents = undefined
    mockDiscoverableAgentsFailed = true
    mockSignupHandoff = { template_slug: 'error-bot' }
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    const view = render(
      <QueryClientProvider client={queryClient}>
        <DraftsProvider>
          <CreateAgentForm />
        </DraftsProvider>
      </QueryClientProvider>,
    )

    await waitFor(() => {
      expect(screen.queryByTestId('template-install-dialog')).toBeNull()
    })

    mockDiscoverableAgentsFailed = false
    mockDiscoverableAgents = [discoverable('error-bot')]
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <DraftsProvider>
          <CreateAgentForm />
        </DraftsProvider>
      </QueryClientProvider>,
    )

    await new Promise((r) => setTimeout(r, 50))
    expect(screen.queryByTestId('template-install-dialog')).toBeNull()
  })
})
