// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { createElement, StrictMode, useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { DraftsProvider, useDraftsStore, type ComposerDraft } from '@renderer/context/drafts-context'
import type { Attachment } from '@renderer/components/messages/attachment-preview'
import { useMessageComposer } from './use-message-composer'

vi.mock('@renderer/hooks/use-mounts', () => ({
  useAddMount: () => ({ mutateAsync: vi.fn() }),
}))

vi.mock('@renderer/hooks/use-voice-input', () => ({
  useVoiceInput: () => ({
    state: 'idle',
    isRecording: false,
    isConnecting: false,
    error: null,
    clearError: vi.fn(),
    isSupported: false,
    analyserRef: { current: null },
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
  }),
}))

vi.mock('@renderer/lib/error-reporting', () => ({ captureRendererException: vi.fn() }))
// No chips here: nothing to load for them, and nothing to check before a send.
vi.mock('./use-composer-chips', () => {
  const context = {}
  return { useComposerChips: () => ({ context, check: async () => context, dialog: null }) }
})

function createWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return createElement(
      StrictMode,
      null,
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(DraftsProvider, null, children),
      ),
    )
  }
}

const KEY = 'session:agent-home:agent-a'
const text = (name: string) => new File(['x'], name, { type: 'text/plain' })

/** A composer that mounts onto a draft something left there: an earlier visit, a fork, a stale session's Start Fresh. */
function useDraftedComposer(
  draft: ComposerDraft,
  options: Omit<Parameters<typeof useMessageComposer>[0], 'draftKey'>,
) {
  const store = useDraftsStore()
  useState(() => store.set(KEY, draft))
  return { store, composer: useMessageComposer({ ...options, draftKey: KEY }) }
}

const upload = (chip: Attachment | undefined) => (chip?.type === 'file' ? chip.upload : undefined)

describe('useMessageComposer drafted attachments (real queue)', () => {
  it('uploads a drafted file that never finished exactly once under StrictMode', async () => {
    const uploadFile = vi.fn().mockResolvedValue({ path: '/workspace/a.txt' })
    const interrupted: Attachment = { type: 'file', id: 'c', file: text('a.txt'), upload: { status: 'uploading', percent: 40, agentSlug: 'agent-a' } }
    const { result } = renderHook(() => useDraftedComposer({ attachments: [interrupted] }, {
      agentSlug: 'agent-a',
      uploadFile,
      uploadFolder: vi.fn(),
      onSubmit: vi.fn(),
    }), { wrapper: createWrapper() })

    await act(async () => {})
    await waitFor(() => {
      expect(uploadFile).toHaveBeenCalledTimes(1)
      expect(upload(result.current.composer.attachments[0])).toMatchObject({ status: 'done', path: '/workspace/a.txt' })
    })
    // Kept as it goes, so the next mount finds it finished.
    expect(upload(result.current.store.get(KEY)?.attachments?.[0])).toMatchObject({ status: 'done', path: '/workspace/a.txt' })
  })

  it('sends a drafted upload that already finished without uploading it again', async () => {
    const uploadFile = vi.fn()
    const done: Attachment = { type: 'file', id: 'd', file: text('a.txt'), upload: { status: 'done', path: '/workspace/a.txt', agentSlug: 'agent-a' } }
    const onSubmit = vi.fn()
    const { result } = renderHook(() => useDraftedComposer({ attachments: [done] }, {
      agentSlug: 'agent-a',
      uploadFile,
      uploadFolder: vi.fn(),
      onSubmit,
    }), { wrapper: createWrapper() })

    await act(async () => { await result.current.composer.submitMessage('see file') })

    expect(uploadFile).not.toHaveBeenCalled()
    expect(onSubmit).toHaveBeenCalledWith(expect.stringContaining('/workspace/a.txt'), { silent: false })
    expect(result.current.store.get(KEY)).toBeUndefined()
  })

  it('uploads again when a drafted file finished under another slug of the agent', async () => {
    // A session reached by the agent's display slug uploads under that slug; the send leaves out a path it finished
    // under a slug that is not this composer's, so the chip that looks done would silently go missing.
    const uploadFile = vi.fn().mockResolvedValue({ path: '/workspace/b.txt' })
    const otherSlug: Attachment = { type: 'file', id: 'o', file: text('b.txt'), upload: { status: 'done', path: '/workspace/b.txt', agentSlug: 'friendly-agent-a' } }
    const onSubmit = vi.fn()
    const { result } = renderHook(() => useDraftedComposer({ attachments: [otherSlug] }, {
      agentSlug: 'agent-a',
      uploadFile,
      uploadFolder: vi.fn(),
      onSubmit,
    }), { wrapper: createWrapper() })

    await waitFor(() => expect(uploadFile).toHaveBeenCalledTimes(1))
    await waitFor(() => {
      expect(upload(result.current.composer.attachments[0])).toMatchObject({ status: 'done', agentSlug: 'agent-a' })
    })
    await act(async () => { await result.current.composer.submitMessage('see file') })
    expect(onSubmit).toHaveBeenCalledWith(expect.stringContaining('/workspace/b.txt'), { silent: false })
  })

  it('tries a drafted file that had failed again on Send, as it would where it failed', async () => {
    const uploadFile = vi.fn().mockResolvedValue({ path: '/workspace/c.txt' })
    const failed: Attachment = { type: 'file', id: 'f', file: text('c.txt'), error: 'Network error', errorRetryable: true }
    const onSubmit = vi.fn()
    const { result } = renderHook(() => useDraftedComposer({ attachments: [failed] }, {
      agentSlug: 'agent-a',
      uploadFile,
      uploadFolder: vi.fn(),
      onSubmit,
    }), { wrapper: createWrapper() })

    // Not on its own: the chip still says it failed, with its retry.
    await act(async () => {})
    expect(uploadFile).not.toHaveBeenCalled()
    expect(result.current.composer.attachments[0]).toMatchObject({ error: 'Network error' })

    await act(async () => { await result.current.composer.submitMessage('see file') })
    expect(uploadFile).toHaveBeenCalledTimes(1)
    expect(onSubmit).toHaveBeenCalledWith(expect.stringContaining('/workspace/c.txt'), { silent: false })
  })

  it('does not send past a drafted file that failed for good', async () => {
    const uploadFile = vi.fn()
    const rejected: Attachment = { type: 'file', id: 'r', file: text('huge.bin'), error: 'File is too large', errorRetryable: false }
    const onSubmit = vi.fn()
    const { result } = renderHook(() => useDraftedComposer({ text: 'see file', attachments: [rejected] }, {
      agentSlug: 'agent-a',
      uploadFile,
      uploadFolder: vi.fn(),
      onSubmit,
    }), { wrapper: createWrapper() })

    let sent: boolean | undefined
    await act(async () => { sent = await result.current.composer.submitMessage('see file') })

    // The message would have gone without the file while its chip sat there.
    expect(sent).toBe(false)
    expect(onSubmit).not.toHaveBeenCalled()
    expect(uploadFile).not.toHaveBeenCalled()
    expect(result.current.store.get(KEY)).toMatchObject({ text: 'see file', attachments: [{ id: 'r' }] })
  })

  it('clears the drafted files when the send navigates away and unmounts the composer', async () => {
    const done: Attachment = { type: 'file', id: 'd', file: text('a.txt'), upload: { status: 'done', path: '/workspace/a.txt', agentSlug: 'agent-a' } }
    let unmountComposer = () => {}
    const onSubmit = vi.fn(async () => { unmountComposer() })
    const { result, unmount } = renderHook(() => useDraftedComposer({ text: 'see file', attachments: [done] }, {
      agentSlug: 'agent-a',
      uploadFile: vi.fn(),
      uploadFolder: vi.fn(),
      onSubmit,
      // The home composers: the draft stays put until the session exists, which is also when the page changes.
      keepMessageUntilComplete: true,
    }), { wrapper: createWrapper() })
    unmountComposer = unmount
    const { store, composer } = result.current

    await act(async () => { await composer.submitMessage('see file') })

    expect(onSubmit).toHaveBeenCalledOnce()
    expect(store.get(KEY)).toBeUndefined()
  })

  it('stops keeping the draft once it has been released to another composer', async () => {
    const uploadFile = vi.fn().mockResolvedValue({ path: '/workspace/a.txt' })
    const { result } = renderHook(() => useDraftedComposer({ text: 'moving' }, {
      agentSlug: 'agent-a',
      uploadFile,
      uploadFolder: vi.fn(),
      onSubmit: vi.fn(),
    }), { wrapper: createWrapper() })

    // Start Fresh: the draft leaves for the home composer while this one is still mounted.
    act(() => {
      result.current.composer.releaseDraft()
      result.current.store.set(KEY, undefined)
    })
    act(() => {
      result.current.composer.setMessage('typed before the page changed')
      result.current.composer.addFiles([{ file: text('late.txt') }])
    })
    await waitFor(() => expect(uploadFile).toHaveBeenCalledTimes(1))
    await act(async () => {})

    expect(result.current.store.get(KEY)).toBeUndefined()
  })
})
