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

  it('starts an existing agent once on first non-empty message', async () => {
    const { rerender } = renderHook(
      ({ message }) =>
        useWarmStartOnType({ agentSlug: 'agent-1', message, enabled: true }),
      { wrapper, initialProps: { message: '' } },
    )

    expect(mutate).not.toHaveBeenCalled()

    rerender({ message: 'hello' })

    await waitFor(() => {
      expect(mutate).toHaveBeenCalledWith('agent-1', expect.any(Object))
    })
    expect(mutate).toHaveBeenCalledTimes(1)

    rerender({ message: 'hello world' })
    await act(async () => {})
    expect(mutate).toHaveBeenCalledTimes(1)
  })

  it('creates then starts when ensureAgent is provided', async () => {
    renderHook(
      () =>
        useWarmStartOnType({
          agentSlug: null,
          message: 'draft',
          enabled: true,
          ensureAgent,
        }),
      { wrapper },
    )

    await waitFor(() => {
      expect(ensureAgent).toHaveBeenCalledTimes(1)
      expect(mutate).toHaveBeenCalledWith('agent-warm', expect.any(Object))
    })
  })

  it('does nothing when disabled', async () => {
    renderHook(
      () =>
        useWarmStartOnType({
          agentSlug: 'agent-1',
          message: 'hello',
          enabled: false,
        }),
      { wrapper },
    )

    await act(async () => {})
    expect(mutate).not.toHaveBeenCalled()
  })

  it('does nothing when runtime is not READY', async () => {
    runtimeStatus.mockReturnValue({
      data: { runtimeReadiness: { status: 'RUNTIME_UNAVAILABLE' } },
    })

    renderHook(
      () =>
        useWarmStartOnType({
          agentSlug: 'agent-1',
          message: 'hello',
          enabled: true,
        }),
      { wrapper },
    )

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

    const { result } = renderHook(
      () =>
        useWarmStartOnType({
          agentSlug: null,
          message: 'hi',
          enabled: true,
          ensureAgent,
        }),
      { wrapper },
    )

    await waitFor(() => expect(ensureAgent).toHaveBeenCalled())

    let awaited: string | null = 'pending' as unknown as null
    void result.current.awaitWarmStart().then((slug) => {
      awaited = slug
    })

    resolveEnsure('agent-warm')
    await waitFor(() => expect(awaited).toBe('agent-warm'))
    expect(mutate).toHaveBeenCalledWith('agent-warm', expect.any(Object))
  })
})
