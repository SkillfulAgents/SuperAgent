// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react'
import { act, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useIsForking, useIsSessionBusy, useSessionRawLog } from './use-sessions'

const mockApiFetch = vi.fn()
vi.mock('@renderer/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
  apiJson: vi.fn(),
}))

const mockDownloadBlob = vi.fn()
vi.mock('@renderer/lib/download', () => ({
  downloadBlob: (...args: unknown[]) => mockDownloadBlob(...args),
}))

const mockToastSuccess = vi.fn()
const mockToastError = vi.fn()
vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
    error: (...args: unknown[]) => mockToastError(...args),
  },
}))

const mockWriteText = vi.fn()

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  return createElement(QueryClientProvider, { client }, children)
}

function renderRawLog() {
  return renderHook(
    () => ({ rawLog: useSessionRawLog(), busy: useIsSessionBusy('session-1'), forking: useIsForking('session-1') }),
    { wrapper },
  )
}

const session = { agentSlug: 'agent-1', sessionId: 'session-1', sessionName: 'Code PR Review' }

/** A promise the test settles by hand, to hold the copy or download open. */
function held() {
  let settle!: { resolve: () => void; reject: (error: Error) => void }
  const promise = new Promise<void>((resolve, reject) => { settle = { resolve, reject } })
  return { promise, ...settle }
}

describe('useSessionRawLog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockApiFetch.mockResolvedValue({ ok: true, text: async () => 'log-line\n' })
    mockWriteText.mockResolvedValue(undefined)
    mockDownloadBlob.mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: mockWriteText } })
  })
  afterEach(() => onlineManager.setOnline(true))

  it.each([
    { copy: true, hold: () => mockWriteText },
    { copy: false, hold: () => mockDownloadBlob },
  ])('keeps the session busy, not forking, until the transfer finishes (copy: $copy)', async ({ copy, hold }) => {
    const transfer = held()
    hold().mockReturnValue(transfer.promise)
    const { result } = renderRawLog()
    expect(result.current.busy).toBe(false)

    act(() => result.current.rawLog.mutate({ ...session, copy }))
    await vi.waitFor(() => expect(hold()).toHaveBeenCalled())
    expect(result.current.busy).toBe(true)
    expect(result.current.forking).toBe(false)

    await act(async () => transfer.resolve())
    await vi.waitFor(() => expect(result.current.busy).toBe(false))
    expect(mockApiFetch).toHaveBeenCalledWith('/api/agents/agent-1/sessions/session-1/raw-log')
    if (copy) {
      expect(mockWriteText).toHaveBeenCalledWith('log-line\n')
      expect(mockToastSuccess).toHaveBeenCalledWith('Copied')
    } else {
      expect(mockDownloadBlob).toHaveBeenCalledWith(expect.anything(), 'Code-PR-Review.jsonl')
      expect(mockToastSuccess).not.toHaveBeenCalled()
    }
  })

  it('names the download after the session id when the name has no usable characters', async () => {
    const { result } = renderRawLog()
    await act(async () => result.current.rawLog.mutateAsync({ ...session, sessionName: '///', copy: false }))
    expect(mockDownloadBlob).toHaveBeenCalledWith(expect.anything(), 'session-1.jsonl')
  })

  it('fetches while the browser reports offline, since the log comes from this app', async () => {
    onlineManager.setOnline(false)
    const { result } = renderRawLog()
    await act(async () => result.current.rawLog.mutateAsync({ ...session, copy: true }))
    expect(mockApiFetch).toHaveBeenCalled()
    expect(mockToastSuccess).toHaveBeenCalledWith('Copied')
  })

  it.each([
    { copy: true, message: 'Could not copy raw log', fail: () => mockApiFetch.mockResolvedValue({ ok: false }), description: 'Failed to fetch raw log' },
    { copy: false, message: 'Could not download raw log', fail: () => mockApiFetch.mockResolvedValue({ ok: false }), description: 'Failed to fetch raw log' },
    { copy: true, message: 'Could not copy raw log', fail: () => mockWriteText.mockRejectedValue(new Error('Clipboard denied')), description: 'Clipboard denied' },
    { copy: false, message: 'Could not download raw log', fail: () => mockDownloadBlob.mockRejectedValue(new Error('Disk full')), description: 'Disk full' },
  ])('toasts "$message" ($description) and clears busy', async ({ copy, message, fail, description }) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    fail()
    const { result } = renderRawLog()

    await act(async () => result.current.rawLog.mutateAsync({ ...session, copy }).catch(() => {}))

    await vi.waitFor(() => expect(result.current.busy).toBe(false))
    expect(mockToastError).toHaveBeenCalledWith(message, { description })
    expect(mockToastSuccess).not.toHaveBeenCalled()
  })
})
