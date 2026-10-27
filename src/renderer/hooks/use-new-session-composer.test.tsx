// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UseComposerOptionsArgs } from '@renderer/components/messages/composer-options'
import type { Attachment } from '@renderer/components/messages/attachment-preview'
import { DraftsProvider } from '@renderer/context/drafts-context'
import { useNewSessionComposer } from './use-new-session-composer'

const mocks = vi.hoisted(() => ({
  createSession: { mutateAsync: vi.fn(), isPending: false },
  createOptions: vi.fn(),
  preferences: {
    data: { defaultModel: 'agent-model', defaultLlmProviderId: 'agent-provider', defaultEffort: 'high', defaultSpeed: 'fast' },
    isFetched: false,
  },
  modelOptions: vi.fn(),
  runtimeOptions: { model: 'chosen-model', llmProviderId: 'chosen-provider', effort: 'medium', speed: 'fast' },
  upload: vi.fn(),
  fetch: vi.fn(),
}))

vi.mock('./use-sessions', () => ({
  useCreateSession: (options: unknown) => {
    mocks.createOptions(options)
    return mocks.createSession
  },
}))
vi.mock('./use-agent-preferences', () => ({ useAgentPreferences: () => mocks.preferences }))
vi.mock('@renderer/components/messages/composer-options', () => ({
  useComposerOptions: (options: UseComposerOptionsArgs) => {
    mocks.modelOptions(options)
    return { toRuntimeOptions: () => mocks.runtimeOptions }
  },
}))
vi.mock('@renderer/lib/upload', () => ({ uploadFileChunked: mocks.upload, UPLOAD_STALL_MS: 30_000 }))
vi.mock('@renderer/lib/api', () => ({ apiFetch: mocks.fetch }))
vi.mock('./use-mounts', () => ({ useAddMount: () => ({ mutateAsync: vi.fn() }) }))
vi.mock('./use-voice-input', () => ({
  useVoiceInput: () => ({
    state: 'idle', isRecording: false, isConnecting: false, error: null,
    clearError: vi.fn(), isSupported: false, analyserRef: { current: null },
    startRecording: vi.fn(), stopRecording: vi.fn(),
  }),
}))
vi.mock('./use-composer-chips', () => {
  const context = {}
  return { useComposerChips: () => ({ context, check: async () => context, dialog: null }) }
})
vi.mock('@renderer/lib/error-reporting', () => ({ captureRendererException: vi.fn() }))

const created = { id: 'session-1', initialMessageUuid: 'server-message-1' }

describe('useNewSessionComposer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.createSession.isPending = false
    mocks.createSession.mutateAsync.mockResolvedValue(created)
    mocks.preferences.isFetched = false
    mocks.upload.mockImplementation(async ({ url }: { url: string }) => ({ path: `${url}/notes.txt` }))
    mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ path: '/workspace/uploads/project' }) })
  })

  it('creates a session without a router and returns the server message identity to the caller', async () => {
    const onSessionCreated = vi.fn()
    const { result } = renderHook(() => useNewSessionComposer({
      agentSlug: 'brain', draftKey: 'team-brain:brain', agentRuntimeErrorsShownInline: true, onSessionCreated,
    }), { wrapper: DraftsProvider })

    act(() => result.current.composer.setMessage('Remember this decision'))
    await act(async () => { await result.current.composer.handleSubmit({ preventDefault() {} }) })

    expect(mocks.createSession.mutateAsync).toHaveBeenCalledWith({
      agentSlug: 'brain', message: 'Remember this decision', ...mocks.runtimeOptions,
    })
    expect(onSessionCreated).toHaveBeenCalledWith({ agentSlug: 'brain', content: 'Remember this decision', session: created })
    expect(mocks.createOptions).toHaveBeenCalledWith({ agentRuntimeErrorsShownInline: true })
    expect(result.current.composer.message).toBe('')
  })

  it('keeps the real composer draft and attachments when dispatch fails, then permits retry', async () => {
    const error = new Error('Agent unavailable')
    mocks.createSession.mutateAsync.mockRejectedValueOnce(error)
    const onError = vi.fn()
    const onSessionCreated = vi.fn()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const file = new File(['notes'], 'notes.txt', { type: 'text/plain' })
    const { result } = renderHook(() => useNewSessionComposer({
      agentSlug: 'writer', draftKey: 'quick-dispatch', onError, onSessionCreated,
      initialAttachments: [{ id: 'carryover-file', type: 'file', file }],
    }), { wrapper: DraftsProvider })
    await waitFor(() => expect(result.current.composer.canSubmit).toBe(true))
    act(() => result.current.composer.setMessage('Use these notes'))

    await act(async () => { await result.current.composer.handleSubmit({ preventDefault() {} }) })
    expect(onError).toHaveBeenCalledWith(error)
    expect(onSessionCreated).not.toHaveBeenCalled()
    expect(result.current.composer.message).toBe('Use these notes')
    expect(result.current.composer.attachments).toHaveLength(1)
    expect(result.current.composer.canSubmit).toBe(true)

    await act(async () => { await result.current.composer.handleSubmit({ preventDefault() {} }) })
    expect(onSessionCreated).toHaveBeenCalledOnce()
    expect(mocks.createSession.mutateAsync.mock.calls[1][0].message).toContain('/api/agents/writer/upload-file/notes.txt')
    expect(result.current.composer.message).toBe('')
    expect(result.current.composer.attachments).toHaveLength(0)
    consoleError.mockRestore()
  })

  it('blocks submission until an agent is selected and respects caller and mutation guards', async () => {
    const { result, rerender } = renderHook(({ agentSlug, submitDisabled }) => useNewSessionComposer({
      agentSlug, submitDisabled, draftKey: 'quick-dispatch', onSessionCreated: vi.fn(),
    }), { wrapper: DraftsProvider, initialProps: { agentSlug: '', submitDisabled: false } })
    act(() => result.current.composer.setMessage('Keep this draft'))
    expect(result.current.isDisabled).toBe(true)
    expect(result.current.composer.canSubmit).toBe(false)
    await act(async () => { await result.current.composer.handleSubmit({ preventDefault() {} }) })
    expect(mocks.createSession.mutateAsync).not.toHaveBeenCalled()

    rerender({ agentSlug: 'writer', submitDisabled: true })
    expect(result.current.composer.canSubmit).toBe(false)
    rerender({ agentSlug: 'writer', submitDisabled: false })
    expect(result.current.composer.canSubmit).toBe(true)
    expect(result.current.composer.message).toBe('Keep this draft')
    mocks.createSession.isPending = true
    rerender({ agentSlug: 'writer', submitDisabled: false })
    expect(result.current.isDisabled).toBe(true)
    expect(result.current.composer.canSubmit).toBe(false)
  })

  it('reuploads file and folder attachments to the newly selected agent before dispatch', async () => {
    const file = new File(['notes'], 'notes.txt', { type: 'text/plain' })
    const initialAttachments: Attachment[] = [
      { id: 'file', type: 'file', file },
      { id: 'folder', type: 'folder', folderName: 'project', folderPath: '/home/test/project', files: [], totalSize: 0 },
    ]
    const { result, rerender } = renderHook(({ agentSlug }) => useNewSessionComposer({
      agentSlug, draftKey: 'quick-dispatch', initialAttachments, onSessionCreated: vi.fn(),
    }), { wrapper: DraftsProvider, initialProps: { agentSlug: 'writer' } })
    await waitFor(() => expect(result.current.composer.canSubmit).toBe(true))
    expect(mocks.upload).toHaveBeenCalledWith(expect.objectContaining({ url: '/api/agents/writer/upload-file', file }))
    expect(mocks.fetch).toHaveBeenCalledWith('/api/agents/writer/upload-folder', expect.objectContaining({
      body: JSON.stringify({ sourcePath: '/home/test/project' }),
    }))

    rerender({ agentSlug: 'planner' })
    await waitFor(() => expect(result.current.composer.canSubmit).toBe(true))
    expect(mocks.upload).toHaveBeenLastCalledWith(expect.objectContaining({ url: '/api/agents/planner/upload-file', file }))
    expect(mocks.fetch).toHaveBeenLastCalledWith('/api/agents/planner/upload-folder', expect.anything())
    await act(async () => { await result.current.composer.handleSubmit({ preventDefault() {} }) })
    const request = mocks.createSession.mutateAsync.mock.calls[0][0]
    expect(request.agentSlug).toBe('planner')
    expect(request.message).toContain('/api/agents/planner/upload-file/notes.txt')
    expect(request.message).not.toContain('/api/agents/writer/upload-file/notes.txt')
  })

  it('hands an in-flight session back with the agent that submitted it even after selection changes', async () => {
    let finish!: (session: typeof created) => void
    mocks.createSession.mutateAsync.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const onSessionCreated = vi.fn()
    const { result, rerender } = renderHook(({ agentSlug }) => useNewSessionComposer({
      agentSlug, draftKey: 'quick-dispatch', onSessionCreated,
    }), { wrapper: DraftsProvider, initialProps: { agentSlug: 'writer' } })
    act(() => result.current.composer.setMessage('Write the report'))
    let submitting!: Promise<void>
    await act(async () => { submitting = result.current.composer.handleSubmit({ preventDefault() {} }) })
    expect(result.current.composer.message).toBe('Write the report')
    rerender({ agentSlug: 'planner' })
    await act(async () => { finish(created); await submitting })
    expect(onSessionCreated).toHaveBeenCalledWith({ agentSlug: 'writer', content: 'Write the report', session: created })
  })

  it('preserves carryover model settings and each surface’s default-adoption policy', () => {
    const initialOptions = { initialModel: 'carryover-model', initialLlmProviderId: 'carryover-provider', initialEffort: 'low' as const, initialSpeed: 'normal' as const }
    const { rerender } = renderHook(({ agentSlug, waitForAgentDefaults, followDefaults }) => useNewSessionComposer({
      agentSlug, draftKey: 'quick-dispatch', initialOptions, waitForAgentDefaults, followDefaults, onSessionCreated: vi.fn(),
    }), { wrapper: DraftsProvider, initialProps: { agentSlug: 'writer', waitForAgentDefaults: true, followDefaults: false } })
    expect(mocks.modelOptions).toHaveBeenLastCalledWith(expect.objectContaining({
      ...initialOptions, agentKey: 'writer', agentDefaultModel: 'agent-model', agentDefaultLlmProviderId: 'agent-provider',
      agentDefaultEffort: 'high', agentDefaultSpeed: 'fast', agentDefaultsReady: false, followDefaults: false,
    }))
    mocks.preferences.isFetched = true
    rerender({ agentSlug: 'planner', waitForAgentDefaults: true, followDefaults: false })
    expect(mocks.modelOptions).toHaveBeenLastCalledWith(expect.objectContaining({ agentKey: 'planner', agentDefaultsReady: true }))
    rerender({ agentSlug: 'planner', waitForAgentDefaults: false, followDefaults: true })
    expect(mocks.modelOptions).toHaveBeenLastCalledWith(expect.objectContaining({ followDefaults: true, agentDefaultsReady: undefined }))
  })
})
