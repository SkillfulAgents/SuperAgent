// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { FilePreviewProvider, useFilePreview, type PreviewSource } from '@renderer/context/file-preview-context'
import { FilePreviewTrayContent } from './file-preview-tray-content'

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

function PreviewHarness({ filePath, source }: { filePath: string; source?: PreviewSource }) {
  const { isOpen, openFile, close } = useFilePreview()
  return <>
    <button onClick={() => openFile(filePath, 'test-agent', undefined, source)}>Open file</button>
    {isOpen && <FilePreviewTrayContent sessionId="test-session" onClose={close} />}
  </>
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('file preview refresh', () => {
  it.each(['workspace', 'drive'] as const)('reloads an already-open %s file when opened again', async kind => {
    let contents = 'Original contents'
    const fetch = vi.fn(async (_url: string) => new Response(contents))
    vi.stubGlobal('fetch', fetch)
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
})
