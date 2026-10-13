// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, act } from '@testing-library/react'
import { NewSessionView } from './new-session-view'
import { renderWithProviders } from '@renderer/test/test-utils'
import type { ApiAgent } from '@renderer/hooks/use-agents'

const testAgent: ApiAgent = {
  avatar: { color: 'tonal-blue', shape: 'circle' } as const,
  slug: 'test-agent',
  displaySlug: 'test-agent',
  name: 'Test Agent',
  createdAt: new Date('2025-01-01'),
  status: 'running',
  containerPort: 3000,
}

const mockCreateSession = {
  mutateAsync: vi.fn(),
  isPending: false,
  error: null,
}
vi.mock('@renderer/hooks/use-sessions', () => ({
  useCreateSession: () => mockCreateSession,
  useSessions: () => ({ data: [] }),
}))

const mockOnSessionCreated = vi.fn()
vi.mock('@renderer/context/pending-messages-context', () => ({
  usePendingMessages: () => ({ onSessionCreated: mockOnSessionCreated }),
}))

let mockCanUseAgent = true
vi.mock('@renderer/context/user-context', () => ({
  useUser: () => ({ canUseAgent: () => mockCanUseAgent }),
  UserProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

const mockRenameUntitled = vi.fn()
vi.mock('@renderer/hooks/use-rename-untitled-agent', () => ({
  useRenameUntitledAgent: () => ({ mutate: mockRenameUntitled }),
}))

vi.mock('@renderer/hooks/use-agent-preferences', () => ({
  useAgentPreferences: () => ({ data: undefined }),
}))

vi.mock('@renderer/hooks/use-runtime-status', () => ({
  useRuntimeStatus: () => ({ data: { runtimeReadiness: { status: 'READY' } }, isPending: false }),
}))

vi.mock('@renderer/hooks/use-warm-start-on-type', () => ({
  useWarmStartOnType: () => ({ noteProgrammaticChange: vi.fn() }),
}))

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
            { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', family: 'sonnet', isLatest: true, icon: 'anthropic', supportedEfforts: ['low', 'medium', 'high'] },
          ],
          defaultModels: { agent: 'sonnet', summarizer: 'sonnet', browser: 'sonnet' },
        },
      ],
    },
  }
  return {
    useSettings: () => ({ ...settings, isSuccess: true }),
    useModelSettings: () => settings,
    useWarmStartOnTypeEnabled: () => false,
  }
})

let capturedComposerOptions: any
vi.mock('@renderer/hooks/use-message-composer', () => ({
  useMessageComposer: (opts: any) => {
    capturedComposerOptions = opts
    return {
      message: '',
      setMessage: vi.fn(),
      attachments: [],
      isDragOver: false,
      removeAttachment: vi.fn(),
      retryAttachment: vi.fn(),
      handleFileSelect: vi.fn(),
      handleFolderSelect: vi.fn(),
      addFiles: vi.fn(),
      dragHandlers: {},
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
      mountDialog: { open: false, onChoice: vi.fn(), folderName: undefined },
      isUploading: false,
      handleSubmit: vi.fn(),
      handlePaste: vi.fn(),
      canSubmit: false,
      uploadError: null,
      clearUploadError: vi.fn(),
      potentialSecrets: [],
      securedSecrets: [],
      dismissPotentialSecret: vi.fn(),
      securePotentialSecret: vi.fn(),
      removeSecuredSecrets: vi.fn(),
    }
  },
}))

describe('NewSessionView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCanUseAgent = true
    mockCreateSession.mutateAsync.mockResolvedValue({ id: 'session-123', initialMessageUuid: 'srv-msg-uuid' })
    capturedComposerOptions = undefined
  })

  it('renders an empty thread with the composer', () => {
    renderWithProviders(<NewSessionView agent={testAgent} />)
    expect(screen.getByTestId('new-session-view')).toBeInTheDocument()
    expect(screen.getByTestId('new-session-input')).toBeInTheDocument()
  })

  it('keeps its draft apart from the Agent Home composer', () => {
    renderWithProviders(<NewSessionView agent={testAgent} />)
    expect(capturedComposerOptions.draftKey).toBe('new-session:test-agent')
  })

  it('creates the session on send and hands off to the shell', async () => {
    renderWithProviders(<NewSessionView agent={testAgent} />)
    await act(() => capturedComposerOptions.onSubmit('Hello agent'))
    expect(mockCreateSession.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ agentSlug: 'test-agent', message: 'Hello agent' })
    )
    expect(mockOnSessionCreated).toHaveBeenCalledWith('session-123', 'Hello agent', 'srv-msg-uuid')
    expect(mockRenameUntitled).not.toHaveBeenCalled()
  })

  it('names an untitled agent from its first message', async () => {
    renderWithProviders(<NewSessionView agent={{ ...testAgent, name: 'Untitled' }} />)
    await act(() => capturedComposerOptions.onSubmit('Triage my inbox'))
    expect(mockRenameUntitled).toHaveBeenCalledWith({ slug: 'test-agent', prompt: 'Triage my inbox' })
  })

  it('shows no composer to a view-only member', () => {
    mockCanUseAgent = false
    renderWithProviders(<NewSessionView agent={testAgent} />)
    expect(screen.queryByTestId('new-session-input')).not.toBeInTheDocument()
  })
})
