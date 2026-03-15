// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AttachmentPreview, type Attachment, type FolderAttachment } from './attachment-preview'

function createFile(name: string, size: number, type: string): File {
  const blob = new Blob(['x'.repeat(size)], { type })
  return new File([blob], name, { type })
}

function createAttachment(overrides: { name?: string; size?: number; type?: string; id?: string; preview?: string } = {}): Attachment {
  const { name = 'file.txt', size = 1024, type = 'text/plain', id = 'att-1', preview } = overrides
  return {
    type: 'file',
    file: createFile(name, size, type),
    id,
    preview,
  }
}

function createFolderAttachment(overrides: { id?: string; folderName?: string; fileCount?: number; totalSize?: number } = {}): FolderAttachment {
  const { id = 'folder-1', folderName = 'my-folder', fileCount = 3, totalSize = 3072 } = overrides
  const files = Array.from({ length: fileCount }, (_, i) => ({
    file: createFile(`file${i}.txt`, Math.floor(totalSize / fileCount), 'text/plain'),
    relativePath: `${folderName}/file${i}.txt`,
  }))
  return {
    type: 'folder',
    id,
    folderName,
    files,
    totalSize,
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

  it('renders folder name', () => {
    const attachments = [createFolderAttachment({ folderName: 'src-utils' })]
    render(<AttachmentPreview attachments={attachments} onRemove={vi.fn()} />)
    expect(screen.getByText('src-utils')).toBeInTheDocument()
  })

  it('renders folder file count and total size', () => {
    const attachments = [createFolderAttachment({ fileCount: 3, totalSize: 3072 })]
    render(<AttachmentPreview attachments={attachments} onRemove={vi.fn()} />)
    expect(screen.getByText('3 files · 3.0 KB')).toBeInTheDocument()
  })

  it('renders singular "file" for single-file folder', () => {
    const attachments = [createFolderAttachment({ fileCount: 1, totalSize: 1024 })]
    render(<AttachmentPreview attachments={attachments} onRemove={vi.fn()} />)
    expect(screen.getByText('1 file · 1.0 KB')).toBeInTheDocument()
  })

  it('calls onRemove with folder attachment id when remove button is clicked', async () => {
    const user = userEvent.setup()
    const onRemove = vi.fn()
    const attachments = [createFolderAttachment({ id: 'folder-99' })]
    render(<AttachmentPreview attachments={attachments} onRemove={onRemove} />)

    const removeButton = screen.getByRole('button')
    await user.click(removeButton)
    expect(onRemove).toHaveBeenCalledWith('folder-99')
  })

  it('renders mixed file and folder attachments', () => {
    const attachments: Attachment[] = [
      createAttachment({ id: 'f1', name: 'readme.md' }),
      createFolderAttachment({ id: 'd1', folderName: 'components' }),
    ]
    render(<AttachmentPreview attachments={attachments} onRemove={vi.fn()} />)
    expect(screen.getByText('readme.md')).toBeInTheDocument()
    expect(screen.getByText('components')).toBeInTheDocument()
  })

  it('hides file count for Electron folder attachments (empty files array)', () => {
    const attachment: FolderAttachment = {
      type: 'folder',
      id: 'electron-folder',
      folderName: 'my-project',
      folderPath: '/Users/joe/my-project',
      files: [],
      totalSize: 0,
    }
    render(<AttachmentPreview attachments={[attachment]} onRemove={vi.fn()} />)
    expect(screen.getByText('my-project')).toBeInTheDocument()
    // Should not show "0 files" metadata
    expect(screen.queryByText(/file/)).not.toBeInTheDocument()
  })
})
