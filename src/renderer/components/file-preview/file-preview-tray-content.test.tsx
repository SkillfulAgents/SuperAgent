// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { FilePreviewTrayContent } from './file-preview-tray-content'

vi.mock('@renderer/context/file-preview-context', () => ({
  useFilePreview: () => ({
    openFiles: [{
      filePath: '/workspace/report.md',
      agentSlug: 'test-agent',
      displayName: 'report.md',
      version: 0,
    }],
    activeFileIndex: 0,
    setActiveFile: vi.fn(),
    closeFile: vi.fn(),
    comments: new Map(),
  }),
}))

vi.mock('./file-tab-bar', () => ({ FileTabBar: () => null }))
vi.mock('./renderers/file-renderer', () => ({ FileRenderer: () => null }))
vi.mock('./comments/comment-bar', () => ({ CommentBar: () => null }))

describe('FilePreviewTrayContent', () => {
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
})
