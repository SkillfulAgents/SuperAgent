// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { FilePreviewTrayContent } from './file-preview-tray-content'

const setPdfPage = vi.fn()

vi.mock('@renderer/context/file-preview-context', () => ({
  useFilePreview: () => ({
    openFiles: [{
      filePath: '/workspace/report.pdf',
      agentSlug: 'test-agent',
      displayName: 'report.pdf',
      version: 0,
      pdfPage: 2,
    }],
    activeFileIndex: 0,
    setActiveFile: vi.fn(),
    setPdfPage,
    closeFile: vi.fn(),
    comments: new Map(),
    commentsEnabled: true,
  }),
}))

vi.mock('./file-tab-bar', () => ({ FileTabBar: () => null }))
vi.mock('./comments/comment-bar', () => ({ CommentBar: () => null }))
vi.mock('react-pdf', () => ({
  pdfjs: { GlobalWorkerOptions: {} },
  Document: ({
    children,
    onLoadSuccess,
  }: {
    children: ReactNode
    onLoadSuccess: (pdf: { numPages: number }) => void
  }) => (
    <div>
      <button onClick={() => onLoadSuccess({ numPages: 3 })}>Load PDF</button>
      {children}
    </div>
  ),
  Page: ({ pageNumber }: { pageNumber: number }) => (
    <div data-testid="tray-pdf-page" data-page-number={pageNumber} />
  ),
}))

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
  })
})

beforeEach(() => {
  setPdfPage.mockReset()
})

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

  it('wires the active PDF page and page changes through the tray', async () => {
    render(
      <FilePreviewTrayContent
        sessionId="test-session"
        onClose={vi.fn()}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Load PDF' }))
    expect(screen.getByTestId('tray-pdf-page')).toHaveAttribute('data-page-number', '2')

    fireEvent.click(screen.getByRole('button', { name: 'Next PDF page' }))
    expect(setPdfPage).toHaveBeenCalledWith('/workspace/report.pdf', 3)
  })
})
