// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { FileDeliveryRow } from './file-delivery-row'

const openFile = vi.fn()

vi.mock('@renderer/context/file-preview-context', () => ({
  useFilePreview: () => ({ openFile }),
}))

vi.mock('@renderer/lib/env', () => ({
  getApiBaseUrl: () => 'http://api.test',
}))

describe('FileDeliveryRow', () => {
  beforeEach(() => {
    openFile.mockClear()
  })

  it('renders the filename, description, and size', () => {
    render(
      <FileDeliveryRow
        filePath="/workspace/output/report.pdf"
        agentSlug="test-agent"
        description="Quarterly report"
        sizeBytes={12_800}
      />
    )
    expect(screen.getByTestId('file-delivery-row')).toHaveTextContent('report.pdf')
    expect(screen.getByTestId('file-delivery-meta')).toHaveTextContent('Quarterly report · 12.5 KB')
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

  // The drawer can render these, so the row points at it instead of offering a
  // download the user would have to open from disk.
  it.each(['report.md', 'data.csv', 'chart.png', 'clip.mp4', 'report.pdf', 'notes.txt', 'app.ts'])(
    'points %s at the preview drawer',
    (name) => {
      render(<FileDeliveryRow filePath={`/workspace/output/${name}`} agentSlug="test-agent" />)
      expect(screen.getByTestId('file-delivery-row')).toHaveAttribute('data-file-action', 'preview')
      expect(screen.queryByRole('link')).not.toBeInTheDocument()
    }
  )

  // Nothing to show for these, so downloading is the only useful action.
  it.each(['sheet.xlsx', 'bundle.zip', 'deck.pptx', 'Inter.ttf', 'part.stl'])(
    'offers a download for %s',
    (name) => {
      render(<FileDeliveryRow filePath={`/workspace/output/${name}`} agentSlug="test-agent" />)
      expect(screen.getByTestId('file-delivery-row')).toHaveAttribute('data-file-action', 'download')
      expect(screen.getByRole('link', { name: `Download ${name}` })).toHaveAttribute(
        'href',
        `http://api.test/api/agents/test-agent/files/output/${name}`
      )
    }
  )

  it('opens the file preview on click, but not from the download link', () => {
    render(<FileDeliveryRow filePath="/workspace/output/sheet.xlsx" agentSlug="test-agent" description="Numbers" />)
    fireEvent.click(screen.getByTestId('file-delivery-row'))
    expect(openFile).toHaveBeenCalledWith('/workspace/output/sheet.xlsx', 'test-agent', 'Numbers')

    openFile.mockClear()
    fireEvent.click(screen.getByRole('link'))
    expect(openFile).not.toHaveBeenCalled()
  })

  it('opens the preview from the keyboard', () => {
    render(<FileDeliveryRow filePath="/workspace/output/report.pdf" agentSlug="test-agent" />)
    fireEvent.keyDown(screen.getByTestId('file-delivery-row'), { key: 'Enter' })
    expect(openFile).toHaveBeenCalledTimes(1)
  })

  it('leaves Enter on the download link to the link', () => {
    render(<FileDeliveryRow filePath="/workspace/output/sheet.xlsx" agentSlug="test-agent" />)
    const link = screen.getByRole('link')
    // The row's handler sees this event bubble up; it must not claim it, or the
    // anchor's own activation is cancelled and the preview opens instead.
    fireEvent.keyDown(link, { key: 'Enter', bubbles: true })
    expect(openFile).not.toHaveBeenCalled()
  })
})
