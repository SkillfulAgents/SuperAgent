// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { FilePreviewTrayContent } from './file-preview-tray-content'
import type { PreviewTab } from '@renderer/context/file-preview-context'

const mocks = vi.hoisted((): { openTabs: PreviewTab[]; adoptFilePath: ReturnType<typeof vi.fn> } => ({
  openTabs: [{
    kind: 'file' as const,
    filePath: '/workspace/report.md',
    agentSlug: 'test-agent',
    displayName: 'report.md',
    version: 0,
    pdfPage: 1,
  }],
  adoptFilePath: vi.fn(),
}))

vi.mock('@renderer/context/file-preview-context', () => ({
  useFilePreview: () => ({
    openTabs: mocks.openTabs,
    activeTabIndex: 0,
    setActiveTab: vi.fn(),
    setPdfPage: vi.fn(),
    closeTab: vi.fn(),
    comments: new Map(),
    commentsEnabled: true,
    adoptFilePath: mocks.adoptFilePath,
  }),
}))

vi.mock('./file-tab-bar', () => ({ FileTabBar: () => null }))
vi.mock('./renderers/file-renderer', () => ({
  FileRenderer: ({ filePath }: { filePath: string }) => (
    <div data-testid="file-renderer">{filePath}</div>
  ),
}))
vi.mock('./folder-browser', () => ({ FolderBrowser: () => <div data-testid="folder-browser" /> }))
vi.mock('./comments/comment-bar', () => ({ CommentBar: () => <div data-testid="comment-bar" /> }))

function renderTray(onClose = vi.fn()) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <FilePreviewTrayContent sessionId="test-session" onClose={onClose} />
    </QueryClientProvider>,
  )
}

describe('FilePreviewTrayContent', () => {
  beforeEach(() => {
    mocks.adoptFilePath.mockReset()
    mocks.openTabs = [{
      kind: 'file',
      filePath: '/workspace/report.md',
      agentSlug: 'test-agent',
      displayName: 'report.md',
      version: 0,
      pdfPage: 1,
    }]
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('exposes container-responsive close controls on opposite sides', () => {
    const onClose = vi.fn()
    renderTray(onClose)

    const mobileClose = screen.getByRole('button', { name: 'Close file preview' })
    const desktopClose = screen.getByRole('button', { name: 'Hide files panel' })
    expect(mobileClose).toHaveClass('file-preview-compact-close', 'hidden')
    expect(desktopClose).toHaveClass('file-preview-wide-close', 'inline-flex')

    fireEvent.click(mobileClose)
    fireEvent.click(desktopClose)
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('shows folder navigation without file-only download and comment actions', () => {
    mocks.openTabs = [{
      kind: 'folder',
      rootPath: '/workspace/reports',
      agentSlug: 'test-agent',
      displayName: 'reports',
      expandedPaths: ['/workspace/reports'],
      query: '',
    }]
    renderTray()

    expect(screen.getByTestId('folder-browser')).toBeVisible()
    expect(screen.queryByTitle('Download file')).not.toBeInTheDocument()
    expect(screen.queryByTestId('file-preview-copy')).not.toBeInTheDocument()
    expect(screen.queryByTestId('comment-bar')).not.toBeInTheDocument()
  })

  it('offers copy alongside download when a text file is open', () => {
    renderTray()

    expect(screen.getByTestId('file-preview-copy')).toBeInTheDocument()
  })

  it('hides copy for a file whose bytes could not be text', () => {
    mocks.openTabs = [{
      kind: 'file',
      filePath: '/workspace/diagram.png',
      agentSlug: 'test-agent',
      displayName: 'diagram.png',
      version: 0,
      pdfPage: 1,
    }]
    renderTray()

    expect(screen.queryByTestId('file-preview-copy')).not.toBeInTheDocument()
    expect(screen.getByTitle('Download file')).toBeInTheDocument()
  })

  it('explains when the path cannot be opened', () => {
    mocks.openTabs = [{
      kind: 'file',
      filePath: '/workspace/../secret.md',
      agentSlug: 'test-agent',
      displayName: 'secret.md',
      version: 0,
      pdfPage: 1,
    }]
    renderTray()

    expect(screen.getByText("Couldn't open this file")).toBeInTheDocument()
    expect(screen.queryByTestId('file-renderer')).not.toBeInTheDocument()
  })

  it('loads the stripped path after a heading-jump miss', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })))
    mocks.openTabs = [{
      kind: 'file',
      filePath: '/workspace/output/report.md#results',
      agentSlug: 'test-agent',
      displayName: 'report.md#results',
      version: 0,
      pdfPage: 1,
    }]
    renderTray()

    await waitFor(() => {
      expect(screen.getByTestId('file-renderer')).toHaveTextContent('/workspace/output/report.md')
    })
    expect(mocks.adoptFilePath).toHaveBeenCalledWith(
      '/workspace/output/report.md#results',
      '/workspace/output/report.md',
    )
  })
})
