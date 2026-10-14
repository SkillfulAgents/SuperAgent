// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement, type ReactNode } from 'react'
import type { ModelDefinition } from '@shared/lib/llm-provider/model-catalog-schema'

const fetchAvailability = vi.fn()
vi.mock('@renderer/lib/api', () => ({ apiFetch: (...args: unknown[]) => fetchAvailability(...args) }))

import { useProviderModelAvailability } from './use-provider-model-availability'

const response = (data: unknown) => ({ ok: true, json: async () => data }) as Response
const model = (id: string) => ({ id } as ModelDefinition)
function wrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children)
  }
}

beforeEach(() => fetchAvailability.mockReset())

describe('useProviderModelAvailability', () => {
  it('uses the provider response for model decisions', async () => {
    fetchAvailability.mockResolvedValue(response({ unavailableModelIds: ['model-a'], restrictionName: 'Pro', action: 'upgrade' }))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { result } = renderHook(() => useProviderModelAvailability({ id: 'conn-a', isConfigured: true, supportsModelAvailability: true }), { wrapper: wrapper(client) })
    await waitFor(() => expect(result.current.isUnavailable(model('model-a'))).toBe(true))
    expect(result.current.isUnavailable(model('model-b'))).toBe(false)
    expect(fetchAvailability).toHaveBeenCalledWith('/api/llm-connections/conn-a/model-availability')
  })

  it('never shows one connection’s cached policy for another', async () => {
    fetchAvailability.mockResolvedValueOnce(response({ unavailableModelIds: ['model-a'], restrictionName: 'Pro', action: 'upgrade' }))
    let resolveNext: ((value: Response) => void) | undefined
    fetchAvailability.mockImplementationOnce(() => new Promise<Response>(resolve => { resolveNext = resolve }))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { result, rerender } = renderHook(({ id }) => useProviderModelAvailability({ id, isConfigured: true, supportsModelAvailability: true }),
      { initialProps: { id: 'conn-a' }, wrapper: wrapper(client) })
    await waitFor(() => expect(result.current.isUnavailable(model('model-a'))).toBe(true))
    rerender({ id: 'conn-b' })
    expect(result.current.isUnavailable(model('model-a'))).toBe(false)
    resolveNext?.(response(null))
    await waitFor(() => expect(fetchAvailability).toHaveBeenCalledTimes(2))
  })

  it('drops cached policy on account revision and disconnect', async () => {
    fetchAvailability.mockResolvedValueOnce(response({ unavailableModelIds: ['model-a'], restrictionName: 'Pro', action: 'upgrade' }))
      .mockResolvedValueOnce(response(null))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { result, rerender } = renderHook(({ isConfigured, modelAvailabilityRevision }) =>
      useProviderModelAvailability({ id: 'conn-a', isConfigured, supportsModelAvailability: true, modelAvailabilityRevision }),
    { initialProps: { isConfigured: true, modelAvailabilityRevision: 'org-a' }, wrapper: wrapper(client) })
    await waitFor(() => expect(result.current.isUnavailable(model('model-a'))).toBe(true))
    rerender({ isConfigured: true, modelAvailabilityRevision: 'org-b' })
    expect(result.current.isUnavailable(model('model-a'))).toBe(false)
    await waitFor(() => expect(fetchAvailability).toHaveBeenCalledTimes(2))
    expect(result.current.availability).toBeNull()
    rerender({ isConfigured: false, modelAvailabilityRevision: 'org-b' })
    expect(result.current.availability).toBeNull()
  })

  it('does not request policy for providers without availability support', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { result } = renderHook(() => useProviderModelAvailability({ id: 'ordinary-conn', isConfigured: true, supportsModelAvailability: false }),
      { wrapper: wrapper(client) })
    expect(result.current.availability).toBeNull()
    expect(fetchAvailability).not.toHaveBeenCalled()
  })
})
