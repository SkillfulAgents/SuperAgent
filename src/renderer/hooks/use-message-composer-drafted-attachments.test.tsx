// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, renderHook, act, waitFor } from '@testing-library/react'
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

  it('takes its draft along when its key changes under it', async () => {
    // The session view adopts the session a new session's first message created, and its composer stays mounted.
    // Entering voice mode creates that session without sending what is drafted, so the draft is still owed.
    const uploadFile = vi.fn().mockResolvedValue({ path: '/workspace/a.txt' })
    const { result, rerender } = renderHook(({ draftKey }: { draftKey: string }) => ({
      store: useDraftsStore(),
      composer: useMessageComposer({ agentSlug: 'agent-a', uploadFile, uploadFolder: vi.fn(), onSubmit: vi.fn(), draftKey }),
    }), { wrapper: createWrapper(), initialProps: { draftKey: 'new-session:agent-a' } })
    act(() => {
      result.current.composer.setMessage('still to send')
      result.current.composer.addFiles([{ file: text('a.txt') }])
    })
    await waitFor(() => expect(upload(result.current.store.get('new-session:agent-a')?.attachments?.[0])).toMatchObject({ status: 'done' }))

    rerender({ draftKey: 'session:s-1' })

    expect(result.current.store.get('session:s-1')).toMatchObject({ text: 'still to send', attachments: [{ upload: { status: 'done' } }] })
    // Moved, not copied: the next new session does not start with it.
    expect(result.current.store.get('new-session:agent-a')).toBeUndefined()
    expect(uploadFile).toHaveBeenCalledTimes(1)
  })

  describe('a send that finishes after its composer was left', () => {
    // One store, and a composer on KEY that can be unmounted and mounted again: leaving the page and coming back.
    function renderLeavable(draft: ComposerDraft, options: Omit<Parameters<typeof useMessageComposer>[0], 'draftKey'>) {
      const latest: { store?: ReturnType<typeof useDraftsStore>; composer?: ReturnType<typeof useMessageComposer> } = {}
      function Seed({ children }: { children: React.ReactNode }) {
        const store = useDraftsStore()
        useState(() => store.set(KEY, draft))
        return children
      }
      function Composer() {
        latest.store = useDraftsStore()
        latest.composer = useMessageComposer({ ...options, draftKey: KEY })
        return null
      }
      const Wrapper = createWrapper()
      let mount = 0
      const tree = () => createElement(Wrapper, null, createElement(Seed, null, createElement(Composer, { key: mount })))
      const view = render(tree())
      return {
        latest: latest as Required<typeof latest>,
        leaveAndComeBack: () => {
          mount += 1
          view.rerender(tree())
        },
      }
    }

    const sentChip: Attachment = { type: 'file', id: 'sent', file: text('sent.txt'), upload: { status: 'done', path: '/workspace/sent.txt', agentSlug: 'agent-a' } }

    async function sendThenComeBack() {
      let finish!: () => void
      const onSubmit = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
      const uploadFile = vi.fn().mockResolvedValue({ path: '/workspace/later.txt' })
      const view = renderLeavable({ text: 'first message', attachments: [sentChip] }, {
        agentSlug: 'agent-a',
        uploadFile,
        uploadFolder: vi.fn(),
        onSubmit,
        // Agent Home: the draft stays until the session exists.
        keepMessageUntilComplete: true,
      })
      let sending!: Promise<boolean>
      await act(async () => { sending = view.latest.composer.submitMessage('first message') })
      await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce())
      view.leaveAndComeBack()
      return { view, finishSend: () => act(async () => { finish(); await sending }) }
    }

    it('leaves a file attached since, and the text as edited since', async () => {
      const { view, finishSend } = await sendThenComeBack()
      act(() => {
        view.latest.composer.setMessage('first message, and one more thing')
        view.latest.composer.addFiles([{ file: text('later.txt') }])
      })
      await waitFor(() => expect(upload(view.latest.store.get(KEY)?.attachments?.[1])).toMatchObject({ status: 'done' }))

      await finishSend()

      const kept = view.latest.store.get(KEY)
      expect(kept?.text).toBe('first message, and one more thing')
      expect(kept?.attachments).toHaveLength(1)
      expect(kept?.attachments?.[0]).toMatchObject({ file: { name: 'later.txt' }, upload: { status: 'done' } })
    })

    it('takes what it sent when nothing was added since', async () => {
      const { view, finishSend } = await sendThenComeBack()
      await finishSend()
      expect(view.latest.store.get(KEY)).toBeUndefined()
    })
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
