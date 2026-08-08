// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DraftsProvider } from '@renderer/context/drafts-context'
import type { SignupHandoff } from '@renderer/context/nav-transient-context'

const mockCreateSession = vi.fn()
const mockCreateAgent = vi.fn()
const mockStartAgent = vi.fn()
const mockSetSignupHandoff = vi.fn()
let mockSignupHandoff: SignupHandoff | null = null
let mockWarmStartEnabled = false
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
      llmProviderStatus: [{ id: 'anthropic', catalog: mockCatalog }],
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
  AgentCreationAids: () => null,
}))

vi.mock('@renderer/components/agents/template-install-dialog', () => ({
  TemplateInstallDialog: () => null,
}))

vi.mock('@renderer/components/ui/attachment-picker', () => ({
  AttachmentPicker: () => null,
}))

vi.mock('@renderer/components/ui/voice-input-button', () => ({
  VoiceInputButton: () => null,
  VoiceInputError: () => null,
}))

import { CreateAgentForm } from './create-agent-form'

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
    mockCatalog = catalogFixture()
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

  it('falls back to opus when the carried model is unknown', async () => {
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

  it('uses opus with no behavior change when there is no handoff', async () => {
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
    // 'opus' resolves through the catalog to its latest for display, which is
    // what the unchanged fallback puts on the wire.
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
})
