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
        pageNumber={4}
        onPageChange={onPageChange}
      />,
    )

    act(() => mockDocumentProps.onLoadSuccess({ numPages: 5 }))

    expect(screen.getByTestId('pdf-page')).toHaveAttribute('data-page-number', '4')
    expect(screen.getByText('4 / 5')).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: 'Next PDF page' }))
    expect(onPageChange).toHaveBeenCalledWith(5)
  })

  it('clamps a saved page when a PDF has fewer pages', () => {
    const onPageChange = vi.fn()
    render(
      <PdfRenderer
        url="/files/short.pdf"
        filePath="/workspace/short.pdf"
        pageNumber={8}
        onPageChange={onPageChange}
      />,
    )

    act(() => mockDocumentProps.onLoadSuccess({ numPages: 3 }))

    expect(onPageChange).toHaveBeenCalledWith(3)
    expect(screen.getByTestId('pdf-page')).toHaveAttribute('data-page-number', '3')
    expect(screen.getByText('3 / 3')).toBeVisible()
  })
})
