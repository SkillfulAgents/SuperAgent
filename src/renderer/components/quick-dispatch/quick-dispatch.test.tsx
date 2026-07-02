// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// QuickDispatch wires the reused composer to the launcher's window IPC. These
// tests exercise its OWN logic — default-agent selection, the Enter handler, and
// the dock-drop / reset effects — by mocking the composer + data hooks so we can
// spy on the calls it makes.

// --- controllable mock state (hoisted so the vi.mock factories can read it) ---
const state = vi.hoisted(() => ({
  agents: [] as { slug: string; name: string; lastActivityAt?: string }[],
}))

const composerMock = vi.hoisted(() => ({
  message: '',
  attachments: [] as unknown[],
  isUploading: false,
  canSubmit: true,
  uploadError: null as string | null,
  setMessage: vi.fn(),
  addFiles: vi.fn(),
  clearAttachments: vi.fn(),
  removeAttachment: vi.fn(),
  handleSubmit: vi.fn((e?: { preventDefault?: () => void }) => e?.preventDefault?.()),
  handlePaste: vi.fn(),
  handleFileSelect: vi.fn(),
  handleFolderSelect: vi.fn(),
  clearUploadError: vi.fn(),
  voiceInput: {
    isRecording: false,
    isConnecting: false,
    isFinalizing: false,
    error: null,
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
    clearError: vi.fn(),
  },
  mountDialog: { open: false, onChoice: vi.fn(), folderName: undefined },
  dragHandlers: { onDrop: vi.fn() },
}))

const createSessionMock = vi.hoisted(() => ({
  mutateAsync: vi.fn().mockResolvedValue({ id: 'sess-1' }),
  isPending: false,
}))

// Captures the options QuickDispatch passes to useMessageComposer.
const composerOptionsSpy = vi.hoisted(() => ({ value: null as Record<string, unknown> | null }))

vi.mock('@renderer/hooks/use-agents', () => ({ useAgents: () => ({ data: state.agents }) }))
vi.mock('@renderer/hooks/use-sessions', () => ({ useCreateSession: () => createSessionMock }))
vi.mock('@renderer/hooks/use-message-composer', () => ({
  useMessageComposer: (options: Record<string, unknown>) => {
    composerOptionsSpy.value = options
    return composerMock
  },
}))
vi.mock('@renderer/hooks/use-voice-input', () => ({
  useIsVoiceConfigured: () => true,
  useVoiceInput: () => ({}),
}))
vi.mock('@renderer/components/messages/composer-options', () => ({
  useComposerOptions: () => ({
    model: 'sonnet',
    effort: 'high',
    catalog: [{ family: 'sonnet', isLatest: true, label: 'Sonnet', icon: 'sonnet', supportedEfforts: ['low', 'high'] }],
    setModel: vi.fn(),
    setEffort: vi.fn(),
    toRuntimeOptions: () => ({}),
  }),
  findCatalogModel: () => ({ label: 'Sonnet', icon: 'sonnet' }),
}))

// The inline menus + heavy children pull in their own deps; stub them since these
// tests never open a menu. EFFORT_LABELS must stay a real map (read in the footer).
vi.mock('./quick-dispatch-menus', () => ({
  AgentMenu: () => null,
  AttachMenu: () => null,
  ModelEffortMenu: () => null,
  EFFORT_LABELS: { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra High', max: 'Max' },
}))
vi.mock('@renderer/components/messages/attachment-preview', () => ({ AttachmentPreview: () => null }))
vi.mock('@renderer/components/ui/voice-input-button', () => ({ VoiceInputButton: () => null, VoiceInputError: () => null }))
vi.mock('@renderer/components/ui/upload-error', () => ({ UploadError: () => null }))
vi.mock('@renderer/components/ui/mount-choice-dialog', () => ({ MountChoiceDialog: () => null }))
vi.mock('@renderer/components/ui/model-icon', () => ({ ModelIcon: () => null }))
vi.mock('@renderer/lib/api', () => ({ apiFetch: vi.fn() }))
vi.mock('@renderer/lib/upload', () => ({ uploadFileChunked: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

import { QuickDispatch } from './quick-dispatch'

/** Install a window.electronAPI stub; returns captured main→renderer callbacks. */
function installElectronAPI(overrides: Record<string, unknown> = {}) {
  const listeners: Record<string, () => void> = {}
  const capture = (key: string) =>
    vi.fn((cb: () => void) => {
      listeners[key] = cb
      return vi.fn()
    })
  window.electronAPI = {
    onQuickDispatchShown: capture('shown'),
    onQuickDispatchToggleDictation: capture('toggleDictation'),
    onQuickDispatchAttachPending: capture('attachPending'),
    onQuickDispatchReset: capture('reset'),
    quickDispatchDrainAttach: vi.fn().mockResolvedValue([]),
    readLocalFile: vi.fn(),
    quickDispatchDispatched: vi.fn(),
    quickDispatchClose: vi.fn(),
    quickDispatchResize: vi.fn(),
    quickDispatchSetModal: vi.fn(),
    quickDispatchOpenSettings: vi.fn(),
    quickDispatchDragStart: vi.fn(),
    quickDispatchDragMove: vi.fn(),
    quickDispatchDragEnd: vi.fn(),
    getRecentFiles: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as typeof window.electronAPI
  return listeners
}

beforeEach(() => {
  vi.clearAllMocks()
  // Reset controllable state to defaults.
  state.agents = [{ slug: 'a1', name: 'Agent One', lastActivityAt: '2024-01-01T00:00:00Z' }]
  composerMock.message = ''
  composerMock.attachments = []
  composerMock.isUploading = false
  composerMock.canSubmit = true
  composerMock.uploadError = null
})

afterEach(() => {
  cleanup()
  delete (window as { electronAPI?: unknown }).electronAPI
})

describe('QuickDispatch', () => {
  it('defaults to the most-recently-active agent', async () => {
    state.agents = [
      { slug: 'old', name: 'Older', lastActivityAt: '2024-01-01T00:00:00Z' },
      { slug: 'new', name: 'Newest', lastActivityAt: '2024-03-01T00:00:00Z' },
      { slug: 'mid', name: 'Middle', lastActivityAt: '2024-02-01T00:00:00Z' },
    ]
    installElectronAPI()
    render(<QuickDispatch />)

    // The default-agent effect runs after mount; the footer trigger reflects it.
    await waitFor(() =>
      expect(screen.getByTestId('quick-dispatch-agent-trigger')).toHaveTextContent('Newest'),
    )
    expect(screen.getByTestId('quick-dispatch-input')).toHaveAttribute('placeholder', 'Dispatch Newest…')
  })

  it('dispatches on Enter but inserts a newline on Shift+Enter', async () => {
    installElectronAPI()
    render(<QuickDispatch />)
    await waitFor(() =>
      expect(screen.getByTestId('quick-dispatch-agent-trigger')).toHaveTextContent('Agent One'),
    )
    const input = screen.getByTestId('quick-dispatch-input')

    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(composerMock.handleSubmit).not.toHaveBeenCalled()

    fireEvent.keyDown(input, { key: 'Enter' })
    expect(composerMock.handleSubmit).toHaveBeenCalledTimes(1)
  })

  it('keeps the typed message in the input until the dispatch completes', () => {
    installElectronAPI()
    render(<QuickDispatch />)
    // Without this the composer clears the text up front, so it vanishes while
    // the send spinner is showing.
    expect(composerOptionsSpy.value?.keepMessageUntilComplete).toBe(true)
  })

  it('clears attachments when the window is hidden (reset)', async () => {
    const listeners = installElectronAPI()
    render(<QuickDispatch />)
    await waitFor(() => expect(listeners.reset).toBeTypeOf('function'))

    act(() => listeners.reset())

    expect(composerMock.clearAttachments).toHaveBeenCalledTimes(1)
  })

  it('drains and attaches a dock-dropped file on mount', async () => {
    installElectronAPI({
      quickDispatchDrainAttach: vi.fn().mockResolvedValue(['/tmp/dropped.txt']),
      readLocalFile: vi.fn().mockResolvedValue({
        buffer: new ArrayBuffer(3),
        name: 'dropped.txt',
        type: 'text/plain',
      }),
    })
    render(<QuickDispatch />)

    await waitFor(() => expect(composerMock.addFiles).toHaveBeenCalledTimes(1))
    const attached = composerMock.addFiles.mock.calls[0][0] as { file: File }[]
    expect(attached[0].file.name).toBe('dropped.txt')
  })

  it('also drains when the attach-pending ping fires (already-open case)', async () => {
    const drain = vi.fn().mockResolvedValue([])
    const listeners = installElectronAPI({ quickDispatchDrainAttach: drain })
    render(<QuickDispatch />)
    await waitFor(() => expect(drain).toHaveBeenCalledTimes(1)) // mount drain

    await act(async () => {
      listeners.attachPending()
    })
    expect(drain).toHaveBeenCalledTimes(2) // ping drain
  })
})
