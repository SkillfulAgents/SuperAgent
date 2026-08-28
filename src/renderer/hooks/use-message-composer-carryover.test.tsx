// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { createElement, StrictMode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { DraftsProvider } from '@renderer/context/drafts-context'
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

describe('useMessageComposer carryover (real queue)', () => {
  it('uploads a carried file once under StrictMode', async () => {
    const uploadFile = vi.fn().mockResolvedValue({ path: '/workspace/a.txt' })
    const { result } = renderHook(() => useMessageComposer({
      agentSlug: 'agent-a',
      uploadFile,
      uploadFolder: vi.fn(),
      onSubmit: vi.fn(),
      initialAttachments: [{ type: 'file', id: 'c', file: new File(['x'], 'a.txt') }],
    }), { wrapper: createWrapper() })

    await act(async () => {})
    await waitFor(() => {
      expect(uploadFile).toHaveBeenCalledTimes(1)
      const chip = result.current.attachments[0]
      expect(chip && chip.type === 'file' && chip.upload).toMatchObject({ status: 'done', path: '/workspace/a.txt' })
    })
  })
})
