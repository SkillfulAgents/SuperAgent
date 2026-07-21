// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
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
  }],
}))

vi.mock('@renderer/context/file-preview-context', () => ({
  useFilePreview: () => ({
    openTabs: mocks.openTabs,
    activeTabIndex: 0,
    setActiveTab: vi.fn(),
    closeTab: vi.fn(),
    comments: new Map(),
  }),
}))

vi.mock('./file-tab-bar', () => ({ FileTabBar: () => null }))
vi.mock('./renderers/file-renderer', () => ({ FileRenderer: () => <div data-testid="file-renderer" /> }))
vi.mock('./folder-browser', () => ({ FolderBrowser: () => <div data-testid="folder-browser" /> }))
vi.mock('./comments/comment-bar', () => ({ CommentBar: () => <div data-testid="comment-bar" /> }))

describe('FilePreviewTrayContent', () => {
  beforeEach(() => {
    mocks.openTabs = [{
      kind: 'file',
      filePath: '/workspace/report.md',
      agentSlug: 'test-agent',
      displayName: 'report.md',
      version: 0,
    }]
  })

  it('exposes container-responsive close controls on opposite sides', () => {
    const onClose = vi.fn()
    render(
      <FilePreviewTrayContent
        sessionId="test-session"
        onClose={onClose}
      />,
    )

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

    render(
      <FilePreviewTrayContent
        sessionId="test-session"
        onClose={vi.fn()}
      />,
    )

    expect(screen.getByTestId('folder-browser')).toBeVisible()
    expect(screen.queryByTitle('Download file')).not.toBeInTheDocument()
    expect(screen.queryByTestId('comment-bar')).not.toBeInTheDocument()
  })
})
