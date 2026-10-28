// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const apiFetchMock = vi.fn()
vi.mock('@renderer/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))
vi.mock('@renderer/lib/download', () => ({
  downloadBlob: vi.fn(() => Promise.resolve()),
}))
vi.mock('@renderer/lib/upload', () => ({
  uploadFileChunked: vi.fn(),
}))
vi.mock('@renderer/context/analytics-context', () => ({
  useAnalyticsTracking: () => ({ track: vi.fn() }),
}))
vi.mock('@renderer/hooks/use-skillsets', () => ({
  useSkillsets: () => ({ data: [] }),
}))

import {
  HOST_EXPORT_STATUS_QUERY_KEY,
  useExportAgentFull,
  useHostExportStatus,
} from './use-agent-templates'

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children)
  return Object.assign(wrapper, { queryClient })
}

beforeEach(() => {
  apiFetchMock.mockReset()
})

describe('useHostExportStatus', () => {
  it('parses inProgress from the host status endpoint', async () => {
    apiFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ inProgress: true }),
    })
    const wrapper = createWrapper()
    const { result } = renderHook(() => useHostExportStatus(), { wrapper })

    await waitFor(() => expect(result.current.data).toEqual({ inProgress: true }))
    expect(apiFetchMock).toHaveBeenCalledWith('/api/agents/export-status')
  })

  it('rejects a malformed status payload', async () => {
    apiFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ busy: true }),
    })
    const wrapper = createWrapper()
    const { result } = renderHook(() => useHostExportStatus(), { wrapper })

    await waitFor(() => expect(result.current.isError).toBe(true))
  })
})

describe('useExportAgentFull host status cache', () => {
  it('marks the host busy before the export request starts', async () => {
    let resolveExport: ((value: { ok: boolean; json: () => Promise<unknown> }) => void) | undefined
    apiFetchMock.mockImplementation((url: string) => {
      if (url === '/api/agents/export-status') {
        return Promise.resolve({ ok: true, json: async () => ({ inProgress: false }) })
      }
      return new Promise((resolve) => {
        resolveExport = resolve
      })
    })

    const wrapper = createWrapper()
    const { result } = renderHook(() => useExportAgentFull(), { wrapper })

    act(() => {
      result.current.mutate({ agentSlug: 'open-slide', agentName: 'OpenSlide Studio' })
    })

    await waitFor(() => {
      expect(wrapper.queryClient.getQueryData(HOST_EXPORT_STATUS_QUERY_KEY)).toEqual({
        inProgress: true,
      })
    })

    resolveExport?.({ ok: true, json: async () => ({}) })
    await waitFor(() => expect(result.current.isPending).toBe(false))
  })
})
