// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { usePreviewFileSource } from './use-preview-file-source'

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return createElement(QueryClientProvider, { client }, children)
}

describe('usePreviewFileSource', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uses the path as-is when there is no query or hash', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(
      () => usePreviewFileSource('agent-1', '/workspace/output/report.md', 0),
      { wrapper },
    )

    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.current.filePath).toBe('/workspace/output/report.md')
    expect(result.current.fileUrl).toContain('/files/output/report.md')
    expect(result.current.isResolving).toBe(false)
  })

  it('keeps a literal hash in the filename when that file exists', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 200 })))

    const { result } = renderHook(
      () => usePreviewFileSource('agent-1', '/workspace/output/Issue #12 notes.md', 0),
      { wrapper },
    )

    await waitFor(() => expect(result.current.isResolving).toBe(false))
    expect(result.current.filePath).toBe('/workspace/output/Issue #12 notes.md')
    expect(result.current.fileUrl).toContain('Issue%20%2312%20notes.md')
  })

  it('retries the stripped path when the full destination is missing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })))

    const { result } = renderHook(
      () => usePreviewFileSource('agent-1', '/workspace/output/report.md#results', 0),
      { wrapper },
    )

    await waitFor(() => expect(result.current.filePath).toBe('/workspace/output/report.md'))
    expect(result.current.fileUrl).toContain('/files/output/report.md?inline=true')
    expect(result.current.fileUrl).not.toContain('%23results')
  })
})
