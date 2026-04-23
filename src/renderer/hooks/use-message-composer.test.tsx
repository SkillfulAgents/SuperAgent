// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { createElement } from 'react'
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

vi.mock('@renderer/hooks/use-voice-input', () => ({
  useVoiceInput: () => mockVoiceInput,
}))

const mockAttachments = {
  attachments: [] as any[],
  isDragOver: false,
  addFiles: vi.fn(),
  addFolders: vi.fn(),
  addMounts: vi.fn(),
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

let capturedOnFoldersReceived: ((folders: any[]) => void) | undefined

vi.mock('@renderer/hooks/use-attachments', () => ({
  useAttachments: (opts?: { onFoldersReceived?: (folders: any[]) => void }) => {
    capturedOnFoldersReceived = opts?.onFoldersReceived
    return mockAttachments
  },
}))

vi.mock('@renderer/lib/file-utils', () => ({
  zipFolderFiles: vi.fn().mockResolvedValue(new Blob(['zipped'])),
}))

vi.mock('@shared/lib/utils/attached-files', () => ({
  appendAttachedFiles: vi.fn((msg: string, paths: string[]) => `${msg}\n[Attached files:]\n${paths.join('\n')}`),
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
    expect(mockAttachments.clearAttachments).toHaveBeenCalled()
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

  // --- File upload orchestration ---

  it('uploads file attachments and appends paths to message', async () => {
    mockAttachments.attachments = [
      { type: 'file', file: new File(['content'], 'doc.txt'), id: '1' },
    ]
    const opts = defaultOptions()
    const { result } = renderHook(() => useMessageComposer(opts), { wrapper: createWrapper() })

    act(() => result.current.setMessage('Check this'))

    await act(async () => {
      await result.current.handleSubmit({ preventDefault: vi.fn() } as any)
    })

    expect(opts.uploadFile).toHaveBeenCalledWith({ file: expect.any(File) })
    // Content should have file paths appended
    expect(opts.onSubmit).toHaveBeenCalledWith(expect.stringContaining('[Attached files:]'))
    expect(opts.onSubmit).toHaveBeenCalledWith(expect.stringContaining('/tmp/uploaded-file.txt'))
  })

  it('uploads folder via Electron path', async () => {
    mockAttachments.attachments = [
      { type: 'folder', folderName: 'src', folderPath: '/home/user/src', files: [], totalSize: 100, id: '2' },
    ]
    const opts = defaultOptions()
    const { result } = renderHook(() => useMessageComposer(opts), { wrapper: createWrapper() })

    act(() => result.current.setMessage('Here'))

    await act(async () => {
      await result.current.handleSubmit({ preventDefault: vi.fn() } as any)
    })

    expect(opts.uploadFolder).toHaveBeenCalledWith({ sourcePath: '/home/user/src' })
    expect(opts.onSubmit).toHaveBeenCalledWith(expect.stringContaining('/tmp/uploaded-folder'))
  })

  it('zips and uploads folder for web (no folderPath)', async () => {
    const files = [{ file: new File(['a'], 'a.txt'), relativePath: 'a.txt' }]
    mockAttachments.attachments = [
      { type: 'folder', folderName: 'mydir', folderPath: undefined, files, totalSize: 1, id: '3' },
    ]
    const opts = defaultOptions()
    const { result } = renderHook(() => useMessageComposer(opts), { wrapper: createWrapper() })

    act(() => result.current.setMessage('Folder'))

    await act(async () => {
      await result.current.handleSubmit({ preventDefault: vi.fn() } as any)
    })

    // Should use uploadFile with a .zip file
    expect(opts.uploadFile).toHaveBeenCalledWith({
      file: expect.objectContaining({ name: 'mydir.zip' }),
    })
  })

  it('handles mount attachments via addMountMutation', async () => {
    mockAttachments.attachments = [
      { type: 'mount', folderName: 'data', hostPath: '/data/shared', id: '4' },
    ]
    const opts = defaultOptions()
    const { result } = renderHook(() => useMessageComposer(opts), { wrapper: createWrapper() })

    act(() => result.current.setMessage('Mount this'))

    await act(async () => {
      await result.current.handleSubmit({ preventDefault: vi.fn() } as any)
    })

    expect(mockAddMount.mutateAsync).toHaveBeenCalledWith({
      agentSlug: 'test-agent',
      hostPath: '/data/shared',
      restart: true,
    })
    expect(opts.onSubmit).toHaveBeenCalledWith(expect.stringContaining('[Mounted folders:]'))
  })

  it('appends mounts before files in content', async () => {
    const { appendMountedFolders, appendAttachedFiles } = await import('@shared/lib/utils/attached-files')
    mockAttachments.attachments = [
      { type: 'mount', folderName: 'data', hostPath: '/data', id: '1' },
      { type: 'file', file: new File(['x'], 'x.txt'), id: '2' },
    ]
    const opts = defaultOptions()
    const { result } = renderHook(() => useMessageComposer(opts), { wrapper: createWrapper() })

    act(() => result.current.setMessage('Both'))

    await act(async () => {
      await result.current.handleSubmit({ preventDefault: vi.fn() } as any)
    })

    // appendMountedFolders should be called first, then appendAttachedFiles
    const mountCall = (appendMountedFolders as any).mock.invocationCallOrder[0]
    const fileCall = (appendAttachedFiles as any).mock.invocationCallOrder[0]
    expect(mountCall).toBeLessThan(fileCall)
  })

  it('aborts submit on upload error and preserves message', async () => {
    mockAttachments.attachments = [
      { type: 'file', file: new File(['x'], 'x.txt'), id: '1' },
    ]
    const opts = defaultOptions()
    opts.uploadFile.mockRejectedValue(new Error('Network error'))
    const { result } = renderHook(() => useMessageComposer(opts), { wrapper: createWrapper() })

    act(() => result.current.setMessage('Will fail'))

    await act(async () => {
      await result.current.handleSubmit({ preventDefault: vi.fn() } as any)
    })

    expect(opts.onSubmit).not.toHaveBeenCalled()
    // Message should NOT be cleared since upload failed
    expect(result.current.message).toBe('Will fail')
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
    expect(result.current.removeAttachment).toBe(mockAttachments.removeAttachment)
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
