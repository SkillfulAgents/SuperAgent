// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act } from '@testing-library/react'
import { CreateAgentForm } from './create-agent-form'
import { renderWithProviders } from '@renderer/test/test-utils'
import {
  takePendingSessionSeed,
  clearPendingSessionSeeds,
} from '@renderer/context/pending-session-seed'

const mockNavigate = vi.fn()
const mockCreateAgent = {
  mutateAsync: vi.fn().mockResolvedValue({
    slug: 'new-agent',
    displaySlug: 'new-agent',
    name: 'New Agent',
  }),
}
const mockUpdateAgent = { mutateAsync: vi.fn() }
const mockDeleteAgent = { mutateAsync: vi.fn() }
const mockCreateSession = {
  mutateAsync: vi.fn().mockResolvedValue({ id: 'session-123', initialMessageUuid: 'srv-msg-uuid' }),
  isPending: false,
}

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
}))

vi.mock('@renderer/hooks/use-agents', () => ({
  useCreateAgent: () => mockCreateAgent,
  useUpdateAgent: () => mockUpdateAgent,
  useDeleteAgent: () => mockDeleteAgent,
}))

vi.mock('@renderer/hooks/use-sessions', () => ({
  useCreateSession: () => mockCreateSession,
}))

vi.mock('@renderer/hooks/use-settings', () => ({
  useWarmStartOnTypeEnabled: () => false,
}))

vi.mock('@renderer/hooks/use-warm-start-on-type', () => ({
  useWarmStartOnType: () => ({ awaitWarmStart: async () => null }),
}))

vi.mock('@renderer/hooks/use-start-onboarding-session', () => ({
  useStartOnboardingSession: () => vi.fn(),
}))

vi.mock('@renderer/lib/derive-agent-name', () => ({
  deriveAgentName: vi.fn().mockResolvedValue('Derived Name'),
}))

vi.mock('@renderer/context/analytics-context', () => ({
  useAnalyticsTracking: () => ({ track: vi.fn() }),
}))

vi.mock('@renderer/hooks/use-typewriter-placeholder', () => ({
  useTypewriterPlaceholder: () => 'placeholder',
  DEFAULT_AGENT_PROMPT_EXAMPLES: [],
}))

const mockComposer = {
  message: '',
  setMessage: vi.fn(),
  attachments: [],
  removeAttachment: vi.fn(),
  handlePaste: vi.fn(),
  handleFileSelect: vi.fn(),
  handleFolderSelect: vi.fn(),
  handleSubmit: vi.fn(),
  voiceInput: { isRecording: false, error: null, clearError: vi.fn() },
  isUploading: false,
}

let capturedComposerOptions: {
  keepMessageUntilComplete?: boolean
  submitDisabled?: boolean
  onSubmit: (content: string) => Promise<void>
}

vi.mock('@renderer/hooks/use-message-composer', () => ({
  useMessageComposer: (opts: typeof capturedComposerOptions) => {
    capturedComposerOptions = opts
    return mockComposer
  },
}))

vi.mock('@renderer/components/agents/agent-creation-aids', () => ({
  AgentCreationAids: () => null,
}))

vi.mock('@renderer/components/agents/template-install-dialog', () => ({
  TemplateInstallDialog: () => null,
}))

describe('CreateAgentForm', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearPendingSessionSeeds()
    mockCreateSession.mutateAsync.mockResolvedValue({
      id: 'session-123',
      initialMessageUuid: 'srv-msg-uuid',
    })
    mockCreateAgent.mutateAsync.mockResolvedValue({
      slug: 'new-agent',
      displaySlug: 'new-agent',
      name: 'New Agent',
    })
  })

  it('keeps the typed message visible until create completes', () => {
    renderWithProviders(<CreateAgentForm />)
    expect(capturedComposerOptions.keepMessageUntilComplete).toBe(true)
  })

  it('seeds the pending session message before navigating', async () => {
    const onAgentCreated = vi.fn()
    renderWithProviders(<CreateAgentForm onAgentCreated={onAgentCreated} />)

    await act(async () => {
      await capturedComposerOptions.onSubmit('Hello from wizard')
    })

    expect(mockCreateSession.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        agentSlug: 'new-agent',
        message: 'Hello from wizard',
        model: 'opus',
      }),
    )
    expect(takePendingSessionSeed('session-123')).toMatchObject({
      localId: 'srv-msg-uuid',
      uuid: 'srv-msg-uuid',
      text: 'Hello from wizard',
    })
    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/agents/$slug/sessions/$sessionId',
      params: { slug: 'new-agent', sessionId: 'session-123' },
    })
    expect(onAgentCreated).toHaveBeenCalled()
  })

  it('rethrows on failure (so the composer keeps the typed text) and does not seed', async () => {
    mockCreateSession.mutateAsync.mockRejectedValueOnce(new Error('boom'))
    renderWithProviders(<CreateAgentForm />)

    // Rejection is the keepMessageUntilComplete contract: useMessageComposer
    // only preserves the typed prompt when onSubmit rejects.
    await act(async () => {
      await expect(capturedComposerOptions.onSubmit('Hello from wizard')).rejects.toThrow('boom')
    })

    expect(takePendingSessionSeed('session-123')).toBeUndefined()
    expect(mockNavigate).not.toHaveBeenCalled()
  })
})
