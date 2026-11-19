// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { PdfRenderer } from './pdf-renderer'

interface MockDocumentProps {
  children: ReactNode
  onLoadSuccess: (pdf: { numPages: number }) => void
}

let mockDocumentProps: MockDocumentProps

vi.mock('react-pdf', () => ({
  pdfjs: { GlobalWorkerOptions: {} },
  Document: (props: MockDocumentProps) => {
    mockDocumentProps = props
    return <div data-testid="pdf-document">{props.children}</div>
  },
  Page: ({ pageNumber }: { pageNumber: number }) => (
    <div data-testid="pdf-page" data-page-number={pageNumber} />
  ),
}))

vi.mock('@renderer/context/file-preview-context', () => ({
  useFilePreview: () => ({ commentsFor: () => [], addComment: vi.fn(), commentsEnabled: true }),
}))

vi.mock('@renderer/hooks/use-voice-input', () => ({
  useVoiceInput: () => ({ isRecording: false, isConnecting: false, isFinalizing: false, isSupported: true, error: null, clearError: () => {}, startRecording: async () => {}, stopRecording: async () => undefined }),
  useIsVoiceConfigured: () => true,
}))
vi.mock('@renderer/components/ui/voice-input-button', () => ({ VoiceInputButton: () => null, VoiceInputError: () => null }))

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
  })
})

describe('PdfRenderer', () => {
  it('renders and paginates from its controlled tab page', () => {
    const onPageChange = vi.fn()
    render(
      <PdfRenderer
        url="/files/report.pdf"
        filePath="/workspace/report.pdf"
        agentSlug="test-agent"
        pageNumber={4}
        onPageChange={onPageChange}
      />,
    )

    act(() => mockDocumentProps.onLoadSuccess({ numPages: 5 }))

    expect(screen.getByTestId('pdf-page')).toHaveAttribute('data-page-number', '4')
    expect(screen.getByText('4 / 5')).toBeVisible()
    expect(screen.getByTestId('pdf-pagination')).toHaveClass('z-10')

    const nextPage = screen.getByRole('button', { name: 'Next PDF page' })
    expect(nextPage).toHaveAttribute('type', 'button')
    fireEvent.click(nextPage)
    expect(onPageChange).toHaveBeenCalledWith(5)
  })

  it('clamps a saved page when a PDF has fewer pages', () => {
    const onPageChange = vi.fn()
    render(
      <PdfRenderer
        url="/files/short.pdf"
        filePath="/workspace/short.pdf"
        agentSlug="test-agent"
        pageNumber={8}
        onPageChange={onPageChange}
      />,
    )

    expect(screen.queryByTestId('pdf-page')).not.toBeInTheDocument()
    act(() => mockDocumentProps.onLoadSuccess({ numPages: 3 }))

    expect(onPageChange).toHaveBeenCalledWith(3)
    expect(screen.getByTestId('pdf-page')).toHaveAttribute('data-page-number', '3')
    expect(screen.getByText('3 / 3')).toBeVisible()
  })

  it('puts a C comment on the page it shows, at the mouse', () => {
    render(<PdfRenderer url="/files/report.pdf" filePath="/workspace/report.pdf" agentSlug="test-agent" pageNumber={4} onPageChange={vi.fn()} />)
    act(() => mockDocumentProps.onLoadSuccess({ numPages: 5 }))

    fireEvent.pointerMove(screen.getByTestId('pdf-page'), { clientX: 120, clientY: 80 })
    fireEvent.keyDown(window, { key: 'c' })

    expect(screen.getByText('Page 4')).toBeVisible()
    // Nothing on a page is more precise than the page, so the box opens where the mouse is.
    expect(screen.getByText('Page 4').closest('[data-comment-overlay]')).toHaveStyle({ left: '120px', top: '84px' })
  })
})
