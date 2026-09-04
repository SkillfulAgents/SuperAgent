// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { FilePreviewTrayContent } from './file-preview-tray-content'
import type { PreviewTab } from '@renderer/context/file-preview-context'

const mocks = vi.hoisted((): { openTabs: PreviewTab[] } => ({
  openTabs: [{
    kind: 'file' as const,
    filePath: '/workspace/report.md',
    agentSlug: 'test-agent',
    displayName: 'report.md',
    version: 0,
    pdfPage: 1,
  }],
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
  }),
}))

// The folder title row's host-path actions read the user's role; grant it so a
// folder tab renders them (their own behaviour is covered in
// folder-host-actions.test.tsx).
vi.mock('@renderer/context/user-context', () => ({
  useUser: () => ({ canAdminAgent: () => true }),
}))

vi.mock('@renderer/hooks/use-file-size', () => ({ useFileSize: () => ({ data: 12_800 }) }))
// The drawer's close controls ride in the tab bar's trailing slot; render just that.
vi.mock('./file-tab-bar', () => ({ FileTabBar: ({ trailing }: { trailing?: ReactNode }) => <div>{trailing}</div> }))
vi.mock('./renderers/file-renderer', () => ({ FileRenderer: () => <div data-testid="file-renderer" /> }))
vi.mock('./folder-browser', () => ({ FolderBrowser: () => <div data-testid="folder-browser" /> }))
vi.mock('./comments/comment-bar', () => ({ CommentBar: () => <div data-testid="comment-bar" /> }))

function renderTray(onClose = vi.fn()) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <FilePreviewTrayContent sessionId="test-session" onClose={onClose} />
    </QueryClientProvider>,
  )
}

describe('FilePreviewTrayContent', () => {
  beforeEach(() => {
    mocks.openTabs = [{
      kind: 'file',
      filePath: '/workspace/report.md',
      agentSlug: 'test-agent',
      displayName: 'report.md',
      version: 0,
      pdfPage: 1,
    }]
  })

  it('shows the filename with its size, and the file actions, in the title row', () => {
    renderTray()
    const title = screen.getByTestId('file-preview-title')
    expect(title).toHaveTextContent('report.md')
    expect(screen.getByTestId('file-preview-size')).toHaveTextContent('12.5 KB')
    expect(title.querySelector('[aria-label="Download file"]')).not.toBeNull()
    expect(screen.getByTestId('file-preview-header').querySelector('[aria-label="Download file"]')).toBeNull()
  })

  it('exposes container-responsive close controls after the tabs', () => {
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

    // The folder's host actions sit with its name, the same place a file's
    // copy and download do — not in the panel header.
    expect(screen.getByTestId('file-preview-title')).toContainElement(screen.getByTestId('folder-copy-path'))

    expect(screen.getByTestId('folder-browser')).toBeVisible()
    expect(screen.queryByLabelText('Download file')).not.toBeInTheDocument()
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
    expect(screen.getByLabelText('Download file')).toBeInTheDocument()
  })
})
