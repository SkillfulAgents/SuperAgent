// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { FileDownloadPill } from './file-download-pill'

describe('FileDownloadPill', () => {
  it('renders a file with download link', () => {
    render(<FileDownloadPill filePath="/workspace/uploads/report.pdf" agentSlug="test-agent" />)
    const link = screen.getByRole('link')
    expect(link).toHaveTextContent('report.pdf')
    expect(link).toHaveAttribute('href', expect.stringContaining('report.pdf'))
  })

  it('renders a folder with folder icon and no download link when path ends with /', () => {
    render(<FileDownloadPill filePath="/workspace/uploads/my-project/" agentSlug="test-agent" />)
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
    expect(screen.getByText('my-project')).toBeInTheDocument()
  })

  it('extracts folder name from trailing-slash path', () => {
    render(<FileDownloadPill filePath="/workspace/uploads/datawizz-app/" agentSlug="test-agent" />)
    expect(screen.getByText('datawizz-app')).toBeInTheDocument()
  })

  it('extracts filename from file path', () => {
    render(<FileDownloadPill filePath="/workspace/uploads/1234-notes.txt" agentSlug="test-agent" />)
    expect(screen.getByText('1234-notes.txt')).toBeInTheDocument()
  })

  it('handles nested folder path with trailing slash', () => {
    render(<FileDownloadPill filePath="/workspace/uploads/deep/nested/folder/" agentSlug="test-agent" />)
    expect(screen.getByText('folder')).toBeInTheDocument()
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })
})
