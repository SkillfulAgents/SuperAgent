// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { FilePreviewProvider, useFilePreview } from '@renderer/context/file-preview-context'
import { FilePreviewTrayContent } from './file-preview-tray-content'

vi.mock('@renderer/router/use-route-location', () => ({
  useRouteLocation: () => ({
    selectedAgentSlug: 'test-agent',
    view: { kind: 'session', id: 'test-session' },
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
    <div data-testid="integrated-pdf-page" data-page-number={pageNumber} />
  ),
}))

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
  })
})

function PreviewHarness() {
  const { isOpen, openFile } = useFilePreview()

  return (
    <>
      <button onClick={() => openFile('/workspace/report.pdf', 'test-agent')}>
        Open PDF
      </button>
      {isOpen && (
        <FilePreviewTrayContent
          sessionId="test-session"
          onClose={vi.fn()}
        />
      )}
    </>
  )
}

describe('PDF preview pagination integration', () => {
  it('rerenders the visible PDF page after clicking next', async () => {
    render(
      <FilePreviewProvider sessionId="test-session">
        <PreviewHarness />
      </FilePreviewProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Open PDF' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Load PDF' }))
    expect(screen.getByTestId('integrated-pdf-page')).toHaveAttribute('data-page-number', '1')

    fireEvent.click(screen.getByRole('button', { name: 'Next PDF page' }))
    expect(screen.getByTestId('integrated-pdf-page')).toHaveAttribute('data-page-number', '2')
  })
})
