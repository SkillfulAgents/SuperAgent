// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AttachmentPreview, type Attachment } from './attachment-preview'

function createFile(name: string, size: number, type: string): File {
  const blob = new Blob(['x'.repeat(size)], { type })
  return new File([blob], name, { type })
}

function createAttachment(overrides: Partial<Attachment> & { name?: string; size?: number; type?: string } = {}): Attachment {
  const { name = 'file.txt', size = 1024, type = 'text/plain', ...rest } = overrides
  return {
    file: createFile(name, size, type),
    id: rest.id ?? 'att-1',
    preview: rest.preview,
  }
}

describe('AttachmentPreview', () => {
  it('returns null when attachments array is empty', () => {
    const { container } = render(
      <AttachmentPreview attachments={[]} onRemove={vi.fn()} />
    )
    expect(container.innerHTML).toBe('')
  })

  it('renders file name', () => {
    const attachments = [createAttachment({ name: 'report.pdf' })]
    render(<AttachmentPreview attachments={attachments} onRemove={vi.fn()} />)
    expect(screen.getByText('report.pdf')).toBeInTheDocument()
  })

  it('renders formatted file size in bytes', () => {
    const attachments = [createAttachment({ size: 512 })]
    render(<AttachmentPreview attachments={attachments} onRemove={vi.fn()} />)
    expect(screen.getByText('512 B')).toBeInTheDocument()
  })

  it('renders formatted file size in KB', () => {
    const attachments = [createAttachment({ size: 2048 })]
    render(<AttachmentPreview attachments={attachments} onRemove={vi.fn()} />)
    expect(screen.getByText('2.0 KB')).toBeInTheDocument()
  })

  it('renders formatted file size in MB', () => {
    const attachments = [createAttachment({ size: 5 * 1024 * 1024 })]
    render(<AttachmentPreview attachments={attachments} onRemove={vi.fn()} />)
    expect(screen.getByText('5.0 MB')).toBeInTheDocument()
  })

  it('renders image preview when attachment is an image with preview URL', () => {
    const attachments = [
      createAttachment({
        name: 'photo.png',
        type: 'image/png',
        preview: 'blob:http://localhost/abc123',
      }),
    ]
    render(<AttachmentPreview attachments={attachments} onRemove={vi.fn()} />)
    const img = screen.getByAltText('photo.png')
    expect(img).toBeInTheDocument()
    expect(img).toHaveAttribute('src', 'blob:http://localhost/abc123')
  })

  it('calls onRemove with attachment id when remove button is clicked', async () => {
    const user = userEvent.setup()
    const onRemove = vi.fn()
    const attachments = [createAttachment({ id: 'att-42' })]
    render(<AttachmentPreview attachments={attachments} onRemove={onRemove} />)

    const removeButton = screen.getByRole('button')
    await user.click(removeButton)
    expect(onRemove).toHaveBeenCalledWith('att-42')
  })

  it('renders multiple attachments', () => {
    const attachments = [
      createAttachment({ id: 'a1', name: 'file1.txt' }),
      createAttachment({ id: 'a2', name: 'file2.txt' }),
    ]
    render(<AttachmentPreview attachments={attachments} onRemove={vi.fn()} />)
    expect(screen.getByText('file1.txt')).toBeInTheDocument()
    expect(screen.getByText('file2.txt')).toBeInTheDocument()
  })
})
