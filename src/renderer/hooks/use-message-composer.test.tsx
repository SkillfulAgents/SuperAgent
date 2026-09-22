// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { createElement } from 'react'
import type { Attachment } from '@renderer/components/messages/attachment-preview'
import type { FolderGroup } from '@renderer/lib/file-utils'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { DraftsProvider, useDraft } from '@renderer/context/drafts-context'

// --- Mocks ---

const mockAddMount = {
  mutateAsync: vi.fn().mockResolvedValue({ containerPath: '/mnt/folder' }),
}

vi.mock('@renderer/hooks/use-mounts', () => ({
  useAddMount: () => mockAddMount,
}))

const mockVoiceInput = {
  state: 'idle' as string,
  isRecording: false,
  isConnecting: false,
  error: null as string | null,
  clearError: vi.fn(),
  isSupported: true,
  analyserRef: { current: null },
  startRecording: vi.fn(),
  stopRecording: vi.fn(),
}
let capturedTranscriptUpdate: ((text: string) => void) | undefined

vi.mock('@renderer/hooks/use-voice-input', () => ({
  useVoiceInput: ({ onTranscriptUpdate }: { onTranscriptUpdate: (text: string) => void }) => {
    capturedTranscriptUpdate = onTranscriptUpdate
    return mockVoiceInput
  },
}))

const mockAttachments = {
  attachments: [] as any[],
  isDragOver: false,
  addFiles: vi.fn(),
  addFolders: vi.fn(),
  addMounts: vi.fn(),
  setAttachmentError: vi.fn(),
  clearAttachmentErrors: vi.fn(),
  updateAttachment: vi.fn(),
  removeAttachment: vi.fn(),
  clearAttachments: vi.fn(),
  handleFileSelect: vi.fn(),
  handleFolderSelect: vi.fn(),
  dragHandlers: {
    onDragOver: vi.fn(),
    onDragLeave: vi.fn(),
    onDrop: vi.fn(),
  },
}

let capturedOnFoldersReceived: ((folders: FolderGroup[]) => void) | undefined
let capturedOnAttachmentsAdded: ((added: Attachment[]) => void) | undefined

vi.mock('@renderer/hooks/use-attachments', () => ({
  useAttachments: (options?: { onFoldersReceived?: (folders: FolderGroup[]) => void; onAttachmentsAdded?: (added: Attachment[]) => void }) => {
    capturedOnFoldersReceived = options?.onFoldersReceived
    capturedOnAttachmentsAdded = options?.onAttachmentsAdded
    return mockAttachments
  },
}))

const mockQueue = {
  enqueue: vi.fn(),
  retry: vi.fn(),
  retryAndWait: vi.fn().mockResolvedValue({ ok: true }),
  pathFor: vi.fn(),
  remove: vi.fn(),
  clear: vi.fn(),
  requeueAll: vi.fn(),
}
vi.mock('./use-upload-queue', () => ({ useUploadQueue: () => mockQueue }))

vi.mock('@renderer/lib/file-utils', () => ({
  zipFolderFiles: vi.fn().mockResolvedValue(new Blob(['zipped'])),
}))

vi.mock('@shared/lib/utils/attached-files', () => ({
  appendAttachedFiles: vi.fn((msg: string, paths: string[]) => paths.length === 0 ? msg : `${msg}\n[Attached files:]\n${paths.join('\n')}`),
  appendMountedFolders: vi.fn((msg: string, mounts: any[]) => `${msg}\n[Mounted folders:]\n${mounts.map((m: any) => m.containerPath).join('\n')}`),
}))

// --- Test setup ---

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  function Wrapper({ children }: { children: React.ReactNode }) {
    return createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(DraftsProvider, null, children),
    )
  }
  return Wrapper
}

function defaultOptions() {
  return {
    agentSlug: 'test-agent',
    uploadFile: vi.fn().mockResolvedValue({ path: '/tmp/uploaded-file.txt' }),
    uploadFolder: vi.fn().mockResolvedValue({ path: '/tmp/uploaded-folder' }),
    onSubmit: vi.fn().mockResolvedValue(undefined),
    submitDisabled: false,
  }
}

import { useMessageComposer } from './use-message-composer'

describe('useMessageComposer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockAttachments.attachments = []
    mockVoiceInput.isRecording = false
    mockVoiceInput.isConnecting = false
    mockVoiceInput.stopRecording.mockReturnValue(undefined)
    capturedOnFoldersReceived = undefined
    capturedOnAttachmentsAdded = undefined
    capturedTranscriptUpdate = undefined
    mockQueue.retryAndWait.mockResolvedValue({ ok: true })
  })

  // --- Basic state ---

  it('initializes with empty message', () => {
    const opts = defaultOptions()
    const { result } = renderHook(() => useMessageComposer(opts), { wrapper: createWrapper() })

    expect(result.current.message).toBe('')
    expect(result.current.isUploading).toBe(false)
    expect(result.current.canSubmit).toBe(false)
  })

  it('updates message via setMessage', () => {
    const opts = defaultOptions()
    const { result } = renderHook(() => useMessageComposer(opts), { wrapper: createWrapper() })

    act(() => result.current.setMessage('hello'))
    expect(result.current.message).toBe('hello')
    expect(result.current.canSubmit).toBe(true)
  })

  it('calls onVoiceTranscript before applying a mic transcript', () => {
    const onVoiceTranscript = vi.fn()
    const opts = { ...defaultOptions(), onVoiceTranscript }
    const { result } = renderHook(() => useMessageComposer(opts), { wrapper: createWrapper() })

    expect(capturedTranscriptUpdate).toBeTypeOf('function')
    act(() => {
      capturedTranscriptUpdate?.('spoken')
    })
    expect(onVoiceTranscript).toHaveBeenCalledTimes(1)
    expect(result.current.message).toBe('spoken')
  })

  it('detects, dismisses, and re-detects a potential secret after it is removed', () => {
    const opts = defaultOptions()
    const { result } = renderHook(() => useMessageComposer(opts), { wrapper: createWrapper() })
    const key = ['sk-', 'proj-Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z'].join('')

    act(() => result.current.setMessage(`Use ${key}`))
    expect(result.current.potentialSecrets).toHaveLength(1)

    act(() => result.current.dismissPotentialSecret(result.current.potentialSecrets[0]))
    expect(result.current.potentialSecrets).toEqual([])

    act(() => result.current.setMessage(''))
    act(() => result.current.setMessage(key))
    expect(result.current.potentialSecrets).toHaveLength(1)
  })

  it('replaces a secured key with a masked pill and submits only the .env placeholder', async () => {
    const opts = defaultOptions()
    const { result } = renderHook(() => useMessageComposer(opts), { wrapper: createWrapper() })
    const key = ['gh', 'p_Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z'].join('')

    act(() => result.current.setMessage(`Use ${key} please`))
    act(() => result.current.securePotentialSecret(result.current.potentialSecrets[0], {
      key: 'GitHub Token',
      envVar: 'GITHUB_TOKEN',
    }))

    expect(result.current.message).toBe('Use [GitHub Token | *********] please')
    expect(result.current.securedSecrets).toHaveLength(1)
    expect(JSON.stringify(result.current.securedSecrets)).not.toContain(key)

    await act(async () => {
      await result.current.handleSubmit({ preventDefault: vi.fn() } as any)
    })

    expect(opts.onSubmit).toHaveBeenCalledWith('Use [Key saved to .env - GITHUB_TOKEN] please')
    expect(opts.onSubmit).not.toHaveBeenCalledWith(expect.stringContaining(key))
  })

  // --- canSubmit ---

  it('canSubmit is true when message has content', () => {
    const opts = defaultOptions()
    const { result } = renderHook(() => useMessageComposer(opts), { wrapper: createWrapper() })

    act(() => result.current.setMessage('hello'))
    expect(result.current.canSubmit).toBe(true)
  })

  it('canSubmit is false for whitespace-only message', () => {
    const opts = defaultOptions()
    const { result } = renderHook(() => useMessageComposer(opts), { wrapper: createWrapper() })

    act(() => result.current.setMessage('   '))
    expect(result.current.canSubmit).toBe(false)
  })

  it('canSubmit is true when attachments exist even without message', () => {
    mockAttachments.attachments = [{ type: 'file', file: new File([''], 'test.txt'), id: '1' }]
    const opts = defaultOptions()
    const { result } = renderHook(() => useMessageComposer(opts), { wrapper: createWrapper() })

    expect(result.current.canSubmit).toBe(true)
  })

  it('canSubmit is true when voice is recording', () => {
    mockVoiceInput.isRecording = true
    const opts = defaultOptions()
    const { result } = renderHook(() => useMessageComposer(opts), { wrapper: createWrapper() })

    expect(result.current.canSubmit).toBe(true)
  })

  it('canSubmit is false when submitDisabled', () => {
    const opts = defaultOptions()
    opts.submitDisabled = true
    const { result } = renderHook(() => useMessageComposer(opts), { wrapper: createWrapper() })

    act(() => result.current.setMessage('hello'))
    expect(result.current.canSubmit).toBe(false)
  })

  // --- Submit ---

  it('submits trimmed message and clears state', async () => {
    const opts = defaultOptions()
    const { result } = renderHook(() => useMessageComposer(opts), { wrapper: createWrapper() })

    act(() => result.current.setMessage('  Hello world  '))

    await act(async () => {
      await result.current.handleSubmit({ preventDefault: vi.fn() } as any)
    })

    expect(opts.onSubmit).toHaveBeenCalledWith('Hello world')
    expect(result.current.message).toBe('')
    expect(mockQueue.clear).toHaveBeenCalled()
  })

  it('does not submit empty message', async () => {
    const opts = defaultOptions()
    const { result } = renderHook(() => useMessageComposer(opts), { wrapper: createWrapper() })

    await act(async () => {
      await result.current.handleSubmit({ preventDefault: vi.fn() } as any)
    })

    expect(opts.onSubmit).not.toHaveBeenCalled()
  })

  it('does not submit when submitDisabled', async () => {
    const opts = defaultOptions()
    opts.submitDisabled = true
    const { result } = renderHook(() => useMessageComposer(opts), { wrapper: createWrapper() })

    act(() => result.current.setMessage('hello'))

    await act(async () => {
      await result.current.handleSubmit({ preventDefault: vi.fn() } as any)
    })

    expect(opts.onSubmit).not.toHaveBeenCalled()
  })

  // --- Voice on submit ---

  it('stops voice recording on submit and uses returned text', async () => {
    mockVoiceInput.isRecording = true
    mockVoiceInput.stopRecording.mockReturnValue('voice transcription')
    const opts = defaultOptions()
    const { result } = renderHook(() => useMessageComposer(opts), { wrapper: createWrapper() })

    await act(async () => {
      await result.current.handleSubmit({ preventDefault: vi.fn() } as any)
    })

    expect(mockVoiceInput.stopRecording).toHaveBeenCalled()
    expect(opts.onSubmit).toHaveBeenCalledWith('voice transcription')
  })

  it('stops voice recording when connecting on submit', async () => {
    mockVoiceInput.isConnecting = true
    mockVoiceInput.stopRecording.mockReturnValue('partial text')
    const opts = defaultOptions()
    const { result } = renderHook(() => useMessageComposer(opts), { wrapper: createWrapper() })

    await act(async () => {
      await result.current.handleSubmit({ preventDefault: vi.fn() } as any)
    })

    expect(mockVoiceInput.stopRecording).toHaveBeenCalled()
    expect(opts.onSubmit).toHaveBeenCalledWith('partial text')
  })

  it('awaits the async stop so a late-flushed transcript is the submitted text', async () => {
    mockVoiceInput.isRecording = true
    // stopRecording resolves only once its trailing-transcript flush completes
    let resolveStop!: (text: string) => void
    mockVoiceInput.stopRecording.mockReturnValue(new Promise<string>((res) => { resolveStop = res }))
    const opts = defaultOptions()
    const { result } = renderHook(() => useMessageComposer(opts), { wrapper: createWrapper() })

    await act(async () => {
      const submit = result.current.handleSubmit({ preventDefault: vi.fn() } as any)
      // Still flushing — must not submit before the tail arrives
      expect(opts.onSubmit).not.toHaveBeenCalled()
      resolveStop('flushed tail text')
      await submit
    })

    expect(opts.onSubmit).toHaveBeenCalledWith('flushed tail text')
  })

  describe('upload lifecycle', () => {
    it('enqueues file and folder chips as they are added, never mounts', () => {
      const opts = defaultOptions()
      renderHook(() => useMessageComposer(opts), { wrapper: createWrapper() })
      const file: Attachment = { type: 'file', id: 'f', file: new File([''], 'a.txt') }
      const mount: Attachment = { type: 'mount', id: 'm', folderName: 'x', hostPath: '/x' }
      act(() => capturedOnAttachmentsAdded!([file, mount]))
      expect(mockQueue.enqueue).toHaveBeenCalledTimes(1)
      expect(mockQueue.enqueue).toHaveBeenCalledWith(file)
    })

    it('canSubmit is false while a chip is queued or uploading', () => {
      mockAttachments.attachments = [{ type: 'file', file: new File([''], 't.txt'), id: '1', upload: { status: 'uploading', agentSlug: 'a' } }]
      const opts = defaultOptions()
      const { result } = renderHook(() => useMessageComposer(opts), { wrapper: createWrapper() })
      expect(result.current.canSubmit).toBe(false)
    })

    it('submit sends the done paths in chip order without re-uploading', async () => {
      mockAttachments.attachments = [
        { type: 'file', file: new File([''], 'a.txt'), id: '1', upload: { status: 'done', path: '/a', agentSlug: 'test-agent' } },
        { type: 'file', file: new File([''], 'b.txt'), id: '2', upload: { status: 'done', path: '/b', agentSlug: 'test-agent' } },
      ]
      const opts = defaultOptions()
      const { result } = renderHook(() => useMessageComposer(opts), { wrapper: createWrapper() })
      act(() => result.current.setMessage('hi'))
      await act(async () => { await result.current.handleSubmit({ preventDefault: vi.fn() }) })
      expect(mockQueue.retryAndWait).not.toHaveBeenCalled()
      expect(opts.uploadFile).not.toHaveBeenCalled()
      const content = opts.onSubmit.mock.calls[0][0] as string
      expect(content.indexOf('/a')).toBeLessThan(content.indexOf('/b'))
    })

    it('submit re-uploads errored chips first and stops if they fail again', async () => {
      mockAttachments.attachments = [{ type: 'file', file: new File([''], 'a.txt'), id: '1', error: 'boom' }]
      mockQueue.retryAndWait.mockResolvedValueOnce({ ok: false })
      const opts = defaultOptions()
      const { result } = renderHook(() => useMessageComposer(opts), { wrapper: createWrapper() })
      act(() => result.current.setMessage('keep me'))
      await act(async () => { await result.current.handleSubmit({ preventDefault: vi.fn() }) })
      expect(mockQueue.retryAndWait).toHaveBeenCalled()
      expect(opts.onSubmit).not.toHaveBeenCalled()
      expect(result.current.message).toBe('keep me')
      expect(result.current.uploadError).toBeNull()
    })

    it('submit continues after a successful retry', async () => {
      mockAttachments.attachments = [{ type: 'file', file: new File([''], 'a.txt'), id: '1', error: 'boom' }]
      mockQueue.retryAndWait.mockImplementationOnce(async () => {
        // Same array object: the composer's attachmentsRef points at it
        mockAttachments.attachments.splice(0, 1, { type: 'file', file: new File([''], 'a.txt'), id: '1', upload: { status: 'done', path: '/a', agentSlug: 'test-agent' } })
        return { ok: true }
      })
      const opts = defaultOptions()
      const { result } = renderHook(() => useMessageComposer(opts), { wrapper: createWrapper() })
      act(() => result.current.setMessage('go'))
      await act(async () => { await result.current.handleSubmit({ preventDefault: vi.fn() }) })
      expect(opts.onSubmit).toHaveBeenCalledWith(expect.stringContaining('/a'))
    })

    it('submit omits a path that belongs to a different agent', async () => {
      mockAttachments.attachments = [{
        type: 'file',
        file: new File([''], 'a.txt'),
        id: '1',
        upload: { status: 'done', path: '/other/a.txt', agentSlug: 'other-agent' },
      }]
      const opts = defaultOptions()
      const { result } = renderHook(() => useMessageComposer(opts), { wrapper: createWrapper() })
      act(() => result.current.setMessage('go'))
      await act(async () => { await result.current.handleSubmit({ preventDefault: vi.fn() }) })
      expect(opts.onSubmit).toHaveBeenCalledWith('go')
    })

    it('submit uses the live list when the chip has no path yet', async () => {
      mockAttachments.attachments = [{ type: 'file', file: new File([''], 'a.txt'), id: '1' }]
      mockQueue.pathFor.mockReturnValueOnce({ path: '/workspace/a.txt', agentSlug: 'test-agent' })
      const opts = defaultOptions()
      const { result } = renderHook(() => useMessageComposer(opts), { wrapper: createWrapper() })
      act(() => result.current.setMessage('go'))
      await act(async () => { await result.current.handleSubmit({ preventDefault: vi.fn() }) })
      expect(opts.onSubmit).toHaveBeenCalledWith(expect.stringContaining('/workspace/a.txt'))
    })

    it('submit omits a live-list path that belongs to a different agent', async () => {
      mockAttachments.attachments = [{ type: 'file', file: new File([''], 'b.txt'), id: '2' }]
      mockQueue.pathFor.mockReturnValueOnce({ path: '/other/b.txt', agentSlug: 'other-agent' })
      const opts = defaultOptions()
      const { result } = renderHook(() => useMessageComposer(opts), { wrapper: createWrapper() })
      act(() => result.current.setMessage('go'))
      await act(async () => { await result.current.handleSubmit({ preventDefault: vi.fn() }) })
      expect(opts.onSubmit).toHaveBeenCalledWith('go')
    })

    it('a mount failure sets the banner and stops the send', async () => {
      mockAttachments.attachments = [{ type: 'mount', id: 'm', folderName: 'src', hostPath: '/home/u/src' }]
      mockAddMount.mutateAsync.mockRejectedValueOnce(new Error('mount boom'))
      const opts = defaultOptions()
      const { result } = renderHook(() => useMessageComposer(opts), { wrapper: createWrapper() })
      act(() => result.current.setMessage('x'))
      await act(async () => { await result.current.handleSubmit({ preventDefault: vi.fn() }) })
      expect(result.current.uploadError).toBe('mount boom')
      expect(mockAttachments.setAttachmentError).toHaveBeenCalledWith('m', 'mount boom')
      expect(opts.onSubmit).not.toHaveBeenCalled()
    })

    it('retryAttachment, removeAttachment and clearAttachments go through the queue', () => {
      const opts = defaultOptions()
      const { result } = renderHook(() => useMessageComposer(opts), { wrapper: createWrapper() })
      act(() => { result.current.retryAttachment('1'); result.current.removeAttachment('1'); result.current.clearAttachments() })
      expect(mockQueue.retry).toHaveBeenCalledWith('1')
      expect(mockQueue.remove).toHaveBeenCalledWith('1')
      expect(mockQueue.clear).toHaveBeenCalled()
    })

    it('agent change re-queues every chip', () => {
      const opts = defaultOptions()
      const { rerender } = renderHook(({ slug }) => useMessageComposer({ ...opts, agentSlug: slug }), { initialProps: { slug: 'a' }, wrapper: createWrapper() })
      rerender({ slug: 'b' })
      expect(mockQueue.requeueAll).toHaveBeenCalledTimes(1)
    })

  })

  it('preserves message when onSubmit fails', async () => {
    const opts = defaultOptions()
    opts.onSubmit.mockRejectedValue(new Error('Session creation failed'))
    const { result } = renderHook(() => useMessageComposer(opts), { wrapper: createWrapper() })

    act(() => result.current.setMessage('Important message'))

    await act(async () => {
      await result.current.handleSubmit({ preventDefault: vi.fn() } as any)
    })

    expect(opts.onSubmit).toHaveBeenCalledWith('Important message')
    // Message should NOT be cleared since onSubmit failed
    expect(result.current.message).toBe('Important message')
  })

  // --- Paste handler ---

  it('adds pasted files as attachments', () => {
    const opts = defaultOptions()
    const { result } = renderHook(() => useMessageComposer(opts), { wrapper: createWrapper() })

    const file = new File(['img'], 'screenshot.png', { type: 'image/png' })
    const items = [{
      kind: 'file',
      getAsFile: () => file,
    }]
    const event = {
      clipboardData: { items },
      preventDefault: vi.fn(),
    } as any

    act(() => result.current.handlePaste(event))

    expect(mockAttachments.addFiles).toHaveBeenCalledWith([{ file }])
    expect(event.preventDefault).toHaveBeenCalled()
  })

  it('ignores paste events without files', () => {
    const opts = defaultOptions()
    const { result } = renderHook(() => useMessageComposer(opts), { wrapper: createWrapper() })

    const items = [{ kind: 'string', getAsFile: () => null }]
    const event = {
      clipboardData: { items },
      preventDefault: vi.fn(),
    } as any

    act(() => result.current.handlePaste(event))

    expect(mockAttachments.addFiles).not.toHaveBeenCalled()
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  // --- Mount choice dialog ---

  it('shows mount dialog when folders are received on Electron', () => {
    // Simulate Electron environment
    ;(window as any).electronAPI = {}

    const opts = defaultOptions()
    const { result } = renderHook(() => useMessageComposer(opts), { wrapper: createWrapper() })

    expect(result.current.mountDialog.open).toBe(false)

    // Simulate folders received (the hook passes handleFoldersReceived to useAttachments)
    expect(capturedOnFoldersReceived).toBeDefined()
    act(() => {
      capturedOnFoldersReceived!([{ folderName: 'myFolder', folderPath: '/path', files: [] }])
    })

    expect(result.current.mountDialog.open).toBe(true)
    expect(result.current.mountDialog.folderName).toBe('myFolder')

    delete (window as any).electronAPI
  })

  it('mount dialog upload choice adds folders', () => {
    ;(window as any).electronAPI = {}

    const opts = defaultOptions()
    const { result } = renderHook(() => useMessageComposer(opts), { wrapper: createWrapper() })

    act(() => {
      capturedOnFoldersReceived!([{ folderName: 'dir', folderPath: '/p', files: [] }])
    })

    act(() => result.current.mountDialog.onChoice('upload'))

    expect(mockAttachments.addFolders).toHaveBeenCalledWith([{ folderName: 'dir', folderPath: '/p', files: [] }])
    expect(result.current.mountDialog.open).toBe(false)

    delete (window as any).electronAPI
  })

  it('mount dialog mount choice adds mounts', () => {
    ;(window as any).electronAPI = {}

    const opts = defaultOptions()
    const { result } = renderHook(() => useMessageComposer(opts), { wrapper: createWrapper() })

    act(() => {
      capturedOnFoldersReceived!([{ folderName: 'dir', folderPath: '/p', files: [] }])
    })

    act(() => result.current.mountDialog.onChoice('mount'))

    expect(mockAttachments.addMounts).toHaveBeenCalledWith([{ folderName: 'dir', hostPath: '/p' }])
    expect(result.current.mountDialog.open).toBe(false)

    delete (window as any).electronAPI
  })

  it('mount dialog mount choice falls back to upload for folders without a resolved path', () => {
    ;(window as any).electronAPI = {}

    const opts = defaultOptions()
    const { result } = renderHook(() => useMessageComposer(opts), { wrapper: createWrapper() })

    const withPath = { folderName: 'dir', folderPath: '/p', files: [] }
    const withoutPath = { folderName: 'pathless', folderPath: undefined, files: [] }
    act(() => {
      capturedOnFoldersReceived!([withPath, withoutPath])
    })

    act(() => result.current.mountDialog.onChoice('mount'))

    expect(mockAttachments.addMounts).toHaveBeenCalledWith([{ folderName: 'dir', hostPath: '/p' }])
    expect(mockAttachments.addFolders).toHaveBeenCalledWith([withoutPath])

    delete (window as any).electronAPI
  })

  it('mount dialog cancel choice does nothing', () => {
    ;(window as any).electronAPI = {}

    const opts = defaultOptions()
    const { result } = renderHook(() => useMessageComposer(opts), { wrapper: createWrapper() })

    act(() => {
      capturedOnFoldersReceived!([{ folderName: 'dir', folderPath: '/p', files: [] }])
    })

    act(() => result.current.mountDialog.onChoice('cancel'))

    expect(mockAttachments.addFolders).not.toHaveBeenCalled()
    expect(mockAttachments.addMounts).not.toHaveBeenCalled()
    expect(result.current.mountDialog.open).toBe(false)

    delete (window as any).electronAPI
  })

  it('does not pass onFoldersReceived when not Electron', () => {
    delete (window as any).electronAPI

    const opts = defaultOptions()
    renderHook(() => useMessageComposer(opts), { wrapper: createWrapper() })

    expect(capturedOnFoldersReceived).toBeUndefined()
  })

  // --- Exposes voice input ---

  it('exposes voiceInput from the hook', () => {
    const opts = defaultOptions()
    const { result } = renderHook(() => useMessageComposer(opts), { wrapper: createWrapper() })

    expect(result.current.voiceInput).toBeDefined()
    expect(result.current.voiceInput.isRecording).toBe(false)
    expect(result.current.voiceInput.startRecording).toBeDefined()
  })

  // --- Forwards attachment props ---

  it('forwards attachment-related properties', () => {
    const opts = defaultOptions()
    const { result } = renderHook(() => useMessageComposer(opts), { wrapper: createWrapper() })

    expect(result.current.attachments).toBe(mockAttachments.attachments)
    expect(result.current.isDragOver).toBe(mockAttachments.isDragOver)
    expect(result.current.removeAttachment).toBe(mockQueue.remove)
    expect(result.current.handleFileSelect).toBe(mockAttachments.handleFileSelect)
    expect(result.current.handleFolderSelect).toBe(mockAttachments.handleFolderSelect)
    expect(result.current.dragHandlers).toBe(mockAttachments.dragHandlers)
  })

  // --- Draft persistence via DraftsContext ---

  describe('draft persistence (draftKey)', () => {
    it('writes changes to the store under the given key', () => {
      const wrapper = createWrapper()
      const { result } = renderHook(
        () => ({
          composer: useMessageComposer({ ...defaultOptions(), draftKey: 'session:abc' }),
          draft: useDraft<string>('session:abc'),
        }),
        { wrapper },
      )
      act(() => result.current.composer.setMessage('hi there'))
      expect(result.current.draft[0]).toBe('hi there')
    })

    it('clears the stored draft when the message becomes empty', () => {
      const wrapper = createWrapper()
      const { result } = renderHook(
        () => ({
          composer: useMessageComposer({ ...defaultOptions(), draftKey: 'session:abc' }),
          draft: useDraft<string>('session:abc'),
        }),
        { wrapper },
      )
      act(() => result.current.composer.setMessage('hi'))
      expect(result.current.draft[0]).toBe('hi')
      act(() => result.current.composer.setMessage(''))
      expect(result.current.draft[0]).toBeUndefined()
    })

    it('reflects external writes to the same key into the composer message', () => {
      const wrapper = createWrapper()
      const { result } = renderHook(
        () => ({
          composer: useMessageComposer({ ...defaultOptions(), draftKey: 'session:xyz' }),
          draft: useDraft<string>('session:xyz'),
        }),
        { wrapper },
      )
      expect(result.current.composer.message).toBe('')
      // Simulate an outside caller (e.g. voice feedback) writing to the same key.
      act(() => result.current.draft[1]('injected from outside'))
      expect(result.current.composer.message).toBe('injected from outside')
    })

    it('does not touch the store when no draftKey is provided', () => {
      const wrapper = createWrapper()
      const { result } = renderHook(
        () => ({
          composer: useMessageComposer(defaultOptions()),
          draft: useDraft<string>('session:abc'),
        }),
        { wrapper },
      )
      // Seed the store via the draft hook (sharing the provider with the composer).
      act(() => result.current.draft[1]('preexisting'))
      // Composer has no draftKey — its setMessage must not overwrite the unrelated key.
      act(() => result.current.composer.setMessage('local only'))
      expect(result.current.composer.message).toBe('local only')
      expect(result.current.draft[0]).toBe('preexisting')
    })

    it('persists independently across keys', () => {
      const wrapper = createWrapper()
      const { result } = renderHook(
        () => ({
          a: useMessageComposer({ ...defaultOptions(), draftKey: 'agent:A' }),
          b: useMessageComposer({ ...defaultOptions(), draftKey: 'agent:B' }),
          draftA: useDraft<string>('agent:A'),
          draftB: useDraft<string>('agent:B'),
        }),
        { wrapper },
      )
      act(() => result.current.a.setMessage('A message'))
      act(() => result.current.b.setMessage('B message'))
      expect(result.current.draftA[0]).toBe('A message')
      expect(result.current.draftB[0]).toBe('B message')
    })
  })
})
