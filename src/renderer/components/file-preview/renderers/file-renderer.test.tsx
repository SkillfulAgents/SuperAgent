// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent } from '@testing-library/react'
import { renderWithProviders, screen } from '@renderer/test/test-utils'
import { FilePreviewProbe } from '@renderer/test/file-preview-probe'
import { FileRenderer } from './file-renderer'

vi.mock('./use-file-content', () => ({
  useFileContent: () => ({
    data: {
      text: 'See [sibling](notes.md).\n\n![chart](chart.png)',
      truncated: false,
    },
    isLoading: false,
    error: null,
  }),
}))

describe('FileRenderer markdown links', () => {
  afterEach(cleanup)

  it('opens a relative link from a previewed markdown file in the tray', () => {
    renderWithProviders(
      <>
        <FilePreviewProbe />
        <FileRenderer
          filePath="/workspace/output/report.md"
          fileUrl="/api/agents/agent-1/files/output/report.md"
          agentSlug="agent-1"
          pdfPage={1}
          onPdfPageChange={() => {}}
        />
      </>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'sibling' }))

    expect(screen.getByTestId('file-preview-probe').textContent).toBe(
      '/workspace/output/notes.md|agent-1',
    )
  })

  it('loads a relative image in a previewed markdown file from the workspace', () => {
    renderWithProviders(
      <FileRenderer
        filePath="/workspace/output/report.md"
        fileUrl="/api/agents/agent-1/files/output/report.md"
        agentSlug="agent-1"
        pdfPage={1}
        onPdfPageChange={() => {}}
      />,
    )

    expect(screen.getByRole('img', { name: 'chart' })).toHaveAttribute(
      'src',
      '/api/agents/agent-1/files/output/chart.png?inline=true',
    )
  })
})
