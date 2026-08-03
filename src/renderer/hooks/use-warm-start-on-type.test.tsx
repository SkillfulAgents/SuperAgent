// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useWarmStartOnType } from './use-warm-start-on-type'

const mutate = vi.fn()
const ensureAgent = vi.fn()

vi.mock('@renderer/hooks/use-agents', () => ({
  useStartAgent: () => ({ mutate }),
}))

type RuntimeStatusResult = { data: { runtimeReadiness: { status: string } } }

const runtimeStatus = vi.fn(
  (): RuntimeStatusResult => ({ data: { runtimeReadiness: { status: 'READY' } } }),
)

vi.mock('@renderer/hooks/use-runtime-status', () => ({
  useRuntimeStatus: () => runtimeStatus(),
}))

vi.mock('@renderer/lib/error-reporting', () => ({
  captureRendererException: vi.fn(),
}))

vi.mock('@renderer/context/analytics-context', () => ({
  useAnalyticsTracking: () => ({ track: vi.fn() }),
}))

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

describe('useWarmStartOnType', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ensureAgent.mockResolvedValue('agent-warm')
    runtimeStatus.mockReturnValue({
      data: { runtimeReadiness: { status: 'READY' } },
    })
  })

  it('starts an existing agent once on first non-empty message edit', async () => {
    const { rerender } = renderHook(
      ({ message }) =>
        useWarmStartOnType({ agentSlug: 'agent-1', message, enabled: true }),
      { wrapper, initialProps: { message: '' } },
    )

    expect(mutate).not.toHaveBeenCalled()

    rerender({ message: 'hello' })

    await waitFor(() => {
      expect(mutate).toHaveBeenCalledWith(
        { slug: 'agent-1', source: 'warm-start' },
        expect.any(Object),
      )
    })
    expect(mutate).toHaveBeenCalledTimes(1)

    rerender({ message: 'hello world' })
    await act(async () => {})
    expect(mutate).toHaveBeenCalledTimes(1)
  })

  it('does not start from a restored draft until the user edits', async () => {
    const { rerender } = renderHook(
      ({ message }) =>
        useWarmStartOnType({ agentSlug: 'agent-1', message, enabled: true }),
      { wrapper, initialProps: { message: 'stale draft' } },
    )

    await act(async () => {})
    expect(mutate).not.toHaveBeenCalled()

    rerender({ message: 'stale draft edited' })

    await waitFor(() => {
      expect(mutate).toHaveBeenCalledWith(
        { slug: 'agent-1', source: 'warm-start' },
        expect.any(Object),
      )
    })
  })

  it('creates then starts when ensureAgent is provided', async () => {
    const { rerender } = renderHook(
      ({ message }) =>
        useWarmStartOnType({
          agentSlug: null,
          message,
          enabled: true,
          ensureAgent,
        }),
      { wrapper, initialProps: { message: '' } },
    )

    rerender({ message: 'draft' })

    await waitFor(() => {
      expect(ensureAgent).toHaveBeenCalledTimes(1)
      expect(mutate).toHaveBeenCalledWith(
        { slug: 'agent-warm', source: 'warm-start' },
        expect.any(Object),
      )
    })
  })

  it('retries ensureAgent after a failure', async () => {
    ensureAgent
      .mockRejectedValueOnce(new Error('create failed'))
      .mockResolvedValueOnce('agent-warm')

    const { rerender } = renderHook(
      ({ message }) =>
        useWarmStartOnType({
          agentSlug: null,
          message,
          enabled: true,
          ensureAgent,
        }),
      { wrapper, initialProps: { message: '' } },
    )

    rerender({ message: 'hi' })
    await waitFor(() => expect(ensureAgent).toHaveBeenCalledTimes(1))
    await act(async () => {})
    expect(mutate).not.toHaveBeenCalled()

    // Change message again so the effect re-fires after the latch was cleared.
    rerender({ message: 'hi!' })
    await waitFor(() => {
      expect(ensureAgent).toHaveBeenCalledTimes(2)
      expect(mutate).toHaveBeenCalledWith(
        { slug: 'agent-warm', source: 'warm-start' },
        expect.any(Object),
      )
    })
  })

  it('does nothing when disabled', async () => {
    const { rerender } = renderHook(
      ({ message }) =>
        useWarmStartOnType({
          agentSlug: 'agent-1',
          message,
          enabled: false,
        }),
      { wrapper, initialProps: { message: '' } },
    )

    rerender({ message: 'hello' })
    await act(async () => {})
    expect(mutate).not.toHaveBeenCalled()
  })

  it('does nothing when runtime is not READY', async () => {
    runtimeStatus.mockReturnValue({
      data: { runtimeReadiness: { status: 'RUNTIME_UNAVAILABLE' } },
    })

    const { rerender } = renderHook(
      ({ message }) =>
        useWarmStartOnType({
          agentSlug: 'agent-1',
          message,
          enabled: true,
        }),
      { wrapper, initialProps: { message: '' } },
    )

    rerender({ message: 'hello' })
    await act(async () => {})
    expect(mutate).not.toHaveBeenCalled()
  })

  it('awaitWarmStart joins an in-flight ensure', async () => {
    let resolveEnsure!: (slug: string) => void
    ensureAgent.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveEnsure = resolve
      }),
    )

    const { result, rerender } = renderHook(
      ({ message }) =>
        useWarmStartOnType({
          agentSlug: null,
          message,
          enabled: true,
          ensureAgent,
        }),
      { wrapper, initialProps: { message: '' } },
    )

    rerender({ message: 'hi' })
    await waitFor(() => expect(ensureAgent).toHaveBeenCalled())

    let awaited: string | null = 'pending' as unknown as null
    void result.current.awaitWarmStart().then((slug) => {
      awaited = slug
    })

    resolveEnsure('agent-warm')
    await waitFor(() => expect(awaited).toBe('agent-warm'))
    expect(mutate).toHaveBeenCalledWith(
      { slug: 'agent-warm', source: 'warm-start' },
      expect.any(Object),
    )
  })

  it('awaitWarmStart returns an existing warm slug even when disabled', async () => {
    const { result, rerender } = renderHook(
      ({ message, enabled }) =>
        useWarmStartOnType({
          agentSlug: null,
          message,
          enabled,
          ensureAgent,
        }),
      { wrapper, initialProps: { message: '', enabled: true } },
    )

    rerender({ message: 'hi', enabled: true })
    await waitFor(() => expect(mutate).toHaveBeenCalled())

    rerender({ message: 'hi', enabled: false })
    await expect(result.current.awaitWarmStart()).resolves.toBe('agent-warm')
  })
})
