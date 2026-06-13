// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { FileDownloadPill } from './file-download-pill'

// Mock the file preview context
vi.mock('@renderer/context/file-preview-context', () => ({
  useFilePreview: () => ({
    openFile: vi.fn(),
    openFiles: [],
    activeFileIndex: 0,
    comments: new Map(),
    isOpen: false,
    closeFile: vi.fn(),
    setActiveFile: vi.fn(),
    close: vi.fn(),
    addComment: vi.fn(),
    removeComment: vi.fn(),
    clearComments: vi.fn(),
  }),
  FilePreviewProvider: ({ children }: { children: ReactNode }) => children,
}))

describe('FileDownloadPill', () => {
  it('renders a file with view button', () => {
    render(<FileDownloadPill filePath="/workspace/uploads/report.pdf" agentSlug="test-agent" />)
    const button = screen.getByRole('button')
    expect(button).toHaveTextContent('report.pdf')
  })

  it('renders a folder with folder icon and no button', () => {
    render(<FileDownloadPill filePath="/workspace/uploads/my-project/" agentSlug="test-agent" />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
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
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})
