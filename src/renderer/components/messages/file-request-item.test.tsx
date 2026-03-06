// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FileRequestItem } from './file-request-item'

const mockApiFetch = vi.fn()
vi.mock('@renderer/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}))

const defaultProps = {
  toolUseId: 'tu-1',
  description: 'Please upload a CSV file with user data',
  fileTypes: '.csv,.xlsx',
  sessionId: 's-1',
  agentSlug: 'my-agent',
  onComplete: vi.fn(),
}

describe('FileRequestItem', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders pending state with description and file type hint', () => {
    render(<FileRequestItem {...defaultProps} />)
    expect(screen.getByText('File Requested')).toBeInTheDocument()
    expect(screen.getByText('Please upload a CSV file with user data')).toBeInTheDocument()
    expect(screen.getByText('Suggested types: .csv,.xlsx')).toBeInTheDocument()
  })

  it('renders drop zone with browse prompt', () => {
    render(<FileRequestItem {...defaultProps} />)
    expect(screen.getByText('Drop a file here or click to browse')).toBeInTheDocument()
  })

  it('upload button is disabled when no file is selected', () => {
    render(<FileRequestItem {...defaultProps} />)
    const uploadButton = screen.getByText('Upload').closest('button')!
    expect(uploadButton).toBeDisabled()
  })

  it('shows file name after selecting a file', async () => {
    const user = userEvent.setup()
    render(<FileRequestItem {...defaultProps} />)

    const fileInput = document.querySelector('input[type="file"]')!
    const file = new File(['hello'], 'data.csv', { type: 'text/csv' })
    await user.upload(fileInput as HTMLInputElement, file)

    await waitFor(() => {
      expect(screen.getByText('data.csv')).toBeInTheDocument()
    })
  })

  it('uploads file and provides it to the agent', async () => {
    const user = userEvent.setup()
    // First call: upload-file, returns path
    mockApiFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ path: '/uploads/data.csv' }),
      })
      // Second call: provide-file
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({}),
      })

    render(<FileRequestItem {...defaultProps} />)

    // Select a file
    const fileInput = document.querySelector('input[type="file"]')!
    const file = new File(['hello'], 'data.csv', { type: 'text/csv' })
    await user.upload(fileInput as HTMLInputElement, file)

    // Click upload
    await waitFor(() => {
      expect(screen.getByText('data.csv')).toBeInTheDocument()
    })
    await user.click(screen.getByText('Upload'))

    await waitFor(() => {
      expect(screen.getByText('File uploaded')).toBeInTheDocument()
    })
    expect(defaultProps.onComplete).toHaveBeenCalled()
  })

  it('decline button sends decline request', async () => {
    const user = userEvent.setup()
    mockApiFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({}),
    })

    render(<FileRequestItem {...defaultProps} />)

    // Click the Decline button (left side of the split button)
    await user.click(screen.getByText('Decline'))

    await waitFor(() => {
      expect(screen.getByText('Declined')).toBeInTheDocument()
    })
    expect(defaultProps.onComplete).toHaveBeenCalled()
  })

  it('shows error on upload failure', async () => {
    const user = userEvent.setup()
    mockApiFetch.mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve({ error: 'Upload failed' }),
    })

    render(<FileRequestItem {...defaultProps} />)

    const fileInput = document.querySelector('input[type="file"]')!
    const file = new File(['hello'], 'data.csv', { type: 'text/csv' })
    await user.upload(fileInput as HTMLInputElement, file)

    await waitFor(() => {
      expect(screen.getByText('data.csv')).toBeInTheDocument()
    })
    await user.click(screen.getByText('Upload'))

    await waitFor(() => {
      expect(screen.getByText('Failed to upload file')).toBeInTheDocument()
    })
  })
})
