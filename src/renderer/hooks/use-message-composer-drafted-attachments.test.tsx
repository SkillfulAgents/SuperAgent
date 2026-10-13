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

function useSeededComposer(
  draft: ComposerDraft,
  options: Omit<Parameters<typeof useMessageComposer>[0], 'draftKey'>,
) {
  const store = useDraftsStore()
  useState(() => store.set('agent:agent-a', draft))
  return { store, composer: useMessageComposer({ ...options, draftKey: 'agent:agent-a' }) }
}

describe('useMessageComposer drafted attachments (real queue)', () => {
  it('uploads a drafted file that never finished exactly once under StrictMode', async () => {
    const uploadFile = vi.fn().mockResolvedValue({ path: '/workspace/a.txt' })
    const pending: Attachment = { type: 'file', id: 'c', file: new File(['x'], 'a.txt'), upload: { status: 'uploading', agentSlug: 'agent-a' } }
    const { result } = renderHook(() => useSeededComposer({ attachments: [pending] }, {
      agentSlug: 'agent-a',
      uploadFile,
      uploadFolder: vi.fn(),
      onSubmit: vi.fn(),
    }), { wrapper: createWrapper() })

    await act(async () => {})
    await waitFor(() => {
      expect(uploadFile).toHaveBeenCalledTimes(1)
      const chip = result.current.composer.attachments[0]
      expect(chip && chip.type === 'file' && chip.upload).toMatchObject({ status: 'done', path: '/workspace/a.txt' })
    })
    expect(result.current.store.get('agent:agent-a')?.attachments?.[0]).toMatchObject({ upload: { status: 'done' } })
  })

  it('reuses a drafted upload that already finished', async () => {
    const uploadFile = vi.fn()
    const done: Attachment = { type: 'file', id: 'd', file: new File(['x'], 'a.txt'), upload: { status: 'done', path: '/workspace/a.txt', agentSlug: 'agent-a' } }
    const onSubmit = vi.fn()
    const { result } = renderHook(() => useSeededComposer({ attachments: [done] }, {
      agentSlug: 'agent-a',
      uploadFile,
      uploadFolder: vi.fn(),
      onSubmit,
    }), { wrapper: createWrapper() })

    await act(async () => { await result.current.composer.submitMessage('see file') })

    expect(uploadFile).not.toHaveBeenCalled()
    expect(onSubmit).toHaveBeenCalledWith(expect.stringContaining('/workspace/a.txt'))
  })

  it('uploads again when a drafted file finished under another slug for the agent', async () => {
    const uploadFile = vi.fn().mockResolvedValue({ path: '/workspace/b.txt' })
    const otherSlug: Attachment = { type: 'file', id: 'o', file: new File(['x'], 'b.txt'), upload: { status: 'done', path: '/workspace/b.txt', agentSlug: 'friendly-agent-a' } }
    const onSubmit = vi.fn()
    const { result } = renderHook(() => useSeededComposer({ attachments: [otherSlug] }, {
      agentSlug: 'agent-a',
      uploadFile,
      uploadFolder: vi.fn(),
      onSubmit,
    }), { wrapper: createWrapper() })

    await waitFor(() => expect(uploadFile).toHaveBeenCalledTimes(1))
    await waitFor(() => {
      const chip = result.current.composer.attachments[0]
      expect(chip && chip.type === 'file' && chip.upload).toMatchObject({ status: 'done', agentSlug: 'agent-a' })
    })
    await act(async () => { await result.current.composer.submitMessage('see file') })
    expect(onSubmit).toHaveBeenCalledWith(expect.stringContaining('/workspace/b.txt'))
  })

  it('clears the drafted attachments and secrets when submit navigation unmounts the composer', async () => {
    const done: Attachment = { type: 'file', id: 'd', file: new File(['x'], 'a.txt'), upload: { status: 'done', path: '/workspace/a.txt', agentSlug: 'agent-a' } }
    const secret = { id: 's', key: 'Token', envVar: 'TOKEN', displayText: '[Token]' }
    let unmountComposer = () => {}
    const onSubmit = vi.fn(async () => { unmountComposer() })
    const { result, unmount } = renderHook(() => useSeededComposer({ attachments: [done], securedSecrets: [secret] }, {
      agentSlug: 'agent-a',
      uploadFile: vi.fn(),
      uploadFolder: vi.fn(),
      onSubmit,
      keepMessageUntilComplete: true,
    }), { wrapper: createWrapper() })
    unmountComposer = unmount
    const { store, composer } = result.current

    await act(async () => { await composer.submitMessage('') })

    expect(onSubmit).toHaveBeenCalledOnce()
    expect(store.get('agent:agent-a')).toBeUndefined()
  })
})
