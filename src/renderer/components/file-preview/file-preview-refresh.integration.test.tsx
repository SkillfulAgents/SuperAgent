// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { FilePreviewProvider, useFilePreview, type PreviewSource } from '@renderer/context/file-preview-context'
import { FilePreviewTrayContent } from './file-preview-tray-content'
import { CHANGE_CHECK_INTERVAL_MS, useCheckDeliveredFiles } from './use-reload-when-changed'

vi.mock('@renderer/router/use-route-location', () => ({
  useRouteLocation: () => ({ view: { kind: 'session', id: 'test-session' } }),
}))
vi.mock('@renderer/hooks/use-file-size', () => ({ useFileSize: () => ({ data: null }) }))
vi.mock('./file-tab-bar', () => ({ FileTabBar: () => null }))
vi.mock('./folder-browser', () => ({ FolderBrowser: () => null }))
vi.mock('./folder-host-actions', () => ({ FolderHostActions: () => null }))
vi.mock('./comments/comment-bar', () => ({ CommentBar: () => null }))
vi.mock('./copy-file-button', () => ({ CopyFileButton: () => null }))
// Keep the renderer's real URL-keyed cache, without loading its Markdown/editor dependencies.
vi.mock('./renderers/file-renderer', async () => {
  const { useFileContent } = await import('./renderers/use-file-content')
  return {
    FileRenderer: ({ fileUrl }: { fileUrl: string }) => {
      const { data } = useFileContent(fileUrl)
      return <div data-testid="file-content">{data?.text}</div>
    },
  }
})

function PreviewHarness({ filePath, source, deliveries = [] }: {
  filePath: string
  source?: PreviewSource
  deliveries?: { id: string; filePath: string }[]
}) {
  const { isOpen, openFile, close } = useFilePreview()
  useCheckDeliveredFiles(deliveries, 'test-agent')
  return <>
    <button onClick={() => openFile(filePath, 'test-agent', undefined, source)}>Open file</button>
    {isOpen && <FilePreviewTrayContent sessionId="test-session" onClose={close} />}
  </>
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('file preview refresh', () => {
  it.each(['workspace', 'drive'] as const)('reloads an already-open %s file when opened again', async kind => {
    let contents = 'Original contents'
    const fetch = vi.fn(async (_url: string) => new Response(contents))
    // The change check's HEADs are the next test's subject; here they find nothing new.
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => (
      init?.method === 'HEAD' ? Promise.resolve(new Response(null, { headers: { etag: 'W/"1-1"' } })) : fetch(url)
    ))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const source = kind === 'drive' ? {
      inlineUrl: '/api/volume-definitions/v1/file?path=README.md&inline=true',
      downloadUrl: '/api/volume-definitions/v1/file?path=README.md',
    } : undefined
    render(
      <QueryClientProvider client={client}>
        <FilePreviewProvider sessionId="test-session">
          <PreviewHarness filePath={kind === 'drive' ? '/Team Brain/README.md' : '/workspace/README.md'} source={source} />
        </FilePreviewProvider>
      </QueryClientProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Open file' }))
    await waitFor(() => expect(screen.getByTestId('file-content')).toHaveTextContent('Original contents'))
    const originalDownload = screen.getByRole('link', { name: 'Download file' }).getAttribute('href')

    // Leave the preview mounted and its query fresh: an explicit reopen must still reread the file.
    contents = 'Updated contents'
    fireEvent.click(screen.getByRole('button', { name: 'Open file' }))
    await waitFor(() => expect(screen.getByTestId('file-content')).toHaveTextContent('Updated contents'))
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls[1][0]).not.toBe(fetch.mock.calls[0][0])

    const download = screen.getByRole('link', { name: 'Download file' }).getAttribute('href')!
    expect(download).not.toBe(originalDownload)
    const previewUrl = new URL(fetch.mock.calls[1][0], window.location.href)
    const downloadUrl = new URL(download, window.location.href)
    expect(downloadUrl.searchParams.get('v')).toBe(previewUrl.searchParams.get('v'))
    expect(downloadUrl.searchParams.get('v')).not.toBeNull()
    client.clear()
  })

  it('reloads an open workspace file when it changes, and not while it stays the same', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let file: { contents: string; etag: string } | null = { contents: 'Original contents', etag: 'W/"1-17"' }
    const reads = vi.fn()
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      if (!file) return new Response(null, { status: 404 })
      if (init?.method === 'HEAD') return new Response(null, { headers: { etag: file.etag } })
      reads()
      return new Response(file.contents)
    })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <FilePreviewProvider sessionId="test-session">
          <PreviewHarness filePath="/workspace/README.md" />
        </FilePreviewProvider>
      </QueryClientProvider>,
    )
    const content = () => screen.getByTestId('file-content')

    fireEvent.click(screen.getByRole('button', { name: 'Open file' }))
    await waitFor(() => expect(content()).toHaveTextContent('Original contents'))
    await act(() => vi.advanceTimersByTimeAsync(3 * CHANGE_CHECK_INTERVAL_MS))
    expect(reads).toHaveBeenCalledTimes(1)

    file = { contents: 'Updated contents', etag: 'W/"2-16"' }
    await act(() => vi.advanceTimersByTimeAsync(CHANGE_CHECK_INTERVAL_MS))
    await waitFor(() => expect(content()).toHaveTextContent('Updated contents'))
    expect(reads).toHaveBeenCalledTimes(2)

    // A deleted file is a change too: the old text does not stay up as if it were current.
    file = null
    await act(() => vi.advanceTimersByTimeAsync(CHANGE_CHECK_INTERVAL_MS))
    await waitFor(() => expect(content()).toBeEmptyDOMElement())
    client.clear()
  })

  it('rechecks an open file the moment it is delivered again, without waiting for the next check', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let file = { contents: 'Original contents', etag: 'W/"1-17"' }
    const heads = vi.fn()
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      if (init?.method !== 'HEAD') return new Response(file.contents)
      heads()
      return new Response(null, { headers: { etag: file.etag } })
    })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const tree = (deliveries: { id: string; filePath: string }[]) => (
      <QueryClientProvider client={client}>
        <FilePreviewProvider sessionId="test-session">
          <PreviewHarness filePath="/workspace/README.md" deliveries={deliveries} />
        </FilePreviewProvider>
      </QueryClientProvider>
    )
    const first = [{ id: 'tc-1', filePath: '/workspace/README.md' }]
    const { rerender } = render(tree(first))

    fireEvent.click(screen.getByRole('button', { name: 'Open file' }))
    await waitFor(() => expect(screen.getByTestId('file-content')).toHaveTextContent('Original contents'))
    await act(() => vi.advanceTimersByTimeAsync(CHANGE_CHECK_INTERVAL_MS))
    const before = heads.mock.calls.length

    // The same deliveries drawn again ask nothing; a new one asks at once, well inside the interval.
    rerender(tree([...first]))
    await act(() => vi.advanceTimersByTimeAsync(10))
    expect(heads).toHaveBeenCalledTimes(before)

    file = { contents: 'Updated contents', etag: 'W/"2-16"' }
    rerender(tree([...first, { id: 'tc-2', filePath: '/workspace/README.md' }, { id: 'tc-3', filePath: '/workspace/other.md' }]))
    await act(() => vi.advanceTimersByTimeAsync(10))
    expect(heads).toHaveBeenCalledTimes(before + 1)
    await waitFor(() => expect(screen.getByTestId('file-content')).toHaveTextContent('Updated contents'))
    client.clear()
  })
})
