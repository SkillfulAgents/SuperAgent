// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { createElement } from 'react'
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
      QueryClientProvider,
      { client: queryClient },
      createElement(DraftsProvider, null, children),
    )
  }
}

describe('useMessageComposer send-driven retry (real queue)', () => {
  it('a Send that re-uploads a failed chip submits the retried file path', async () => {
    let calls = 0
    const uploadFile = vi.fn(async () => {
      calls += 1
      // Settle from a macrotask, like a real XHR onload/onerror. The retry's
      // 'done' state then commits after handleSubmit has already resumed, so
      // the submitted content must not depend on the rendered chip state.
      await new Promise((r) => setTimeout(r, 0))
      if (calls === 1) throw new Error('boom')
      return { path: '/workspace/uploads/a.txt' }
    })
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const { result } = renderHook(
      () =>
        useMessageComposer({
          agentSlug: 'agent-a',
          uploadFile,
          uploadFolder: vi.fn(),
          onSubmit,
        }),
      { wrapper: createWrapper() },
    )

    const file = new File(['data'], 'a.txt', { type: 'text/plain' })
    await act(async () => {
      result.current.addFiles([{ file }])
    })
    await waitFor(() => {
      const chip = result.current.attachments[0]
      expect(chip && chip.type === 'file' && chip.error).toBe('boom')
    })

    await act(async () => {
      result.current.setMessage('hi')
    })
    await act(async () => {
      await result.current.handleSubmit({ preventDefault: () => {} })
    })

    expect(uploadFile).toHaveBeenCalledTimes(2)
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit.mock.calls[0][0] as string).toContain('/workspace/uploads/a.txt')
  })
})
