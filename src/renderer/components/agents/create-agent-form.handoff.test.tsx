// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DraftsProvider } from '@renderer/context/drafts-context'
import type { SignupHandoff } from '@renderer/context/nav-transient-context'

const mockCreateSession = vi.fn()
const mockCreateAgent = vi.fn()
const mockSetSignupHandoff = vi.fn()
let mockSignupHandoff: SignupHandoff | null = null
let mockCatalog = [
  { id: 'claude-opus-5', family: 'opus', label: 'Opus 5', isLatest: true },
  { id: 'kimi-k3', family: 'kimi', label: 'Kimi K3', isLatest: true },
]

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
  useWarmStartOnTypeEnabled: () => false,
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
    mutate: vi.fn(),
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
    mockCatalog = [
      { id: 'claude-opus-5', family: 'opus', label: 'Opus 5', isLatest: true },
      { id: 'kimi-k3', family: 'kimi', label: 'Kimi K3', isLatest: true },
    ]
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
})
