// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { type ReactNode } from 'react'
import { FileDeliveryRow } from './file-delivery-row'

const openFile = vi.fn()
const openFolder = vi.fn()

vi.mock('@renderer/context/file-preview-context', () => ({
  useFilePreview: () => ({ openFile, openFolder }),
  FilePreviewProvider: ({ children }: { children: ReactNode }) => children,
}))

vi.mock('@renderer/lib/env', () => ({
  getApiBaseUrl: () => 'http://api.test',
}))

describe('FileDeliveryRow', () => {
  beforeEach(() => {
    openFile.mockClear()
    openFolder.mockClear()
  })

  it('renders the filename, description, size, and a download link', () => {
    render(
      <FileDeliveryRow
        filePath="/workspace/output/report.pdf"
        agentSlug="test-agent"
        description="Quarterly report"
        sizeBytes={12_800}
      />
    )
    const row = screen.getByTestId('file-delivery-row')
    expect(row).toHaveTextContent('report.pdf')
    expect(screen.getByTestId('file-delivery-meta')).toHaveTextContent('Quarterly report · 12.5 KB')
    const link = screen.getByRole('link', { name: 'Download report.pdf' })
    expect(link).toHaveAttribute('href', 'http://api.test/api/agents/test-agent/files/output/report.pdf')
  })

  it('falls back to the workspace-relative path when there is no description', () => {
    render(<FileDeliveryRow filePath="/workspace/output/data.csv" agentSlug="test-agent" sizeBytes={256} />)
    expect(screen.getByTestId('file-delivery-meta')).toHaveTextContent('output/data.csv · 256 B')
  })

  it('shows only the size when the path adds nothing to the name', () => {
    render(<FileDeliveryRow filePath="/workspace/notes.txt" agentSlug="test-agent" sizeBytes={10} />)
    expect(screen.getByTestId('file-delivery-meta')).toHaveTextContent('10 B')
  })

  it('omits the metadata line when nothing is known', () => {
    render(<FileDeliveryRow filePath="/workspace/notes.txt" agentSlug="test-agent" />)
    expect(screen.queryByTestId('file-delivery-meta')).not.toBeInTheDocument()
  })

  it('opens the file preview on click, but not from the download link', () => {
    render(<FileDeliveryRow filePath="/workspace/output/report.pdf" agentSlug="test-agent" description="Report" />)
    fireEvent.click(screen.getByTestId('file-delivery-row'))
    expect(openFile).toHaveBeenCalledWith('/workspace/output/report.pdf', 'test-agent', 'Report')

    openFile.mockClear()
    fireEvent.click(screen.getByRole('link'))
    expect(openFile).not.toHaveBeenCalled()
  })

  it('opens the preview from the keyboard', () => {
    render(<FileDeliveryRow filePath="/workspace/output/report.pdf" agentSlug="test-agent" />)
    fireEvent.keyDown(screen.getByTestId('file-delivery-row'), { key: 'Enter' })
    expect(openFile).toHaveBeenCalledTimes(1)
  })

  it('renders folders without a download link and opens the folder browser', () => {
    render(<FileDeliveryRow filePath="/workspace/uploads/my-project/" agentSlug="test-agent" />)
    const row = screen.getByTestId('file-delivery-row')
    expect(row).toHaveTextContent('my-project')
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
    fireEvent.click(row)
    expect(openFolder).toHaveBeenCalledWith('/workspace/uploads/my-project/', 'test-agent')
    expect(openFile).not.toHaveBeenCalled()
  })
})
