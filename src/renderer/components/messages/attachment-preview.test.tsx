// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AttachmentPreview, type Attachment, type FolderAttachment, type MountAttachment, type UploadState } from './attachment-preview'

function createFile(name: string, size: number, type: string): File {
  const blob = new Blob(['x'.repeat(size)], { type })
  return new File([blob], name, { type })
}

function createAttachment(overrides: { name?: string; size?: number; type?: string; id?: string; preview?: string; upload?: UploadState; error?: string } = {}): Attachment {
  const { name = 'file.txt', size = 1024, type = 'text/plain', id = 'att-1', preview, upload, error } = overrides
  return { type: 'file', file: createFile(name, size, type), id, preview, upload, error }
}

function createFolderAttachment(overrides: { id?: string; folderName?: string; fileCount?: number; totalSize?: number; upload?: UploadState; error?: string } = {}): FolderAttachment {
  const { id = 'folder-1', folderName = 'my-folder', fileCount = 3, totalSize = 3072, upload, error } = overrides
  const files = Array.from({ length: fileCount }, (_, i) => ({
    file: createFile(`file${i}.txt`, Math.floor(totalSize / fileCount), 'text/plain'),
    relativePath: `${folderName}/file${i}.txt`,
  }))
  return { type: 'folder', id, folderName, files, totalSize, upload, error }
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

  it('renders mount attachment folder name', () => {
    const attachment: MountAttachment = {
      type: 'mount',
      id: 'mount-1',
      folderName: 'my-data',
      hostPath: '/Users/joe/my-data',
    }
    render(<AttachmentPreview attachments={[attachment]} onRemove={vi.fn()} />)
    expect(screen.getByText('my-data')).toBeInTheDocument()
  })

  it('renders "mounted, read-write" label for mount attachments', () => {
    const attachment: MountAttachment = {
      type: 'mount',
      id: 'mount-1',
      folderName: 'my-data',
      hostPath: '/Users/joe/my-data',
    }
    render(<AttachmentPreview attachments={[attachment]} onRemove={vi.fn()} />)
    expect(screen.getByText('mounted, read-write')).toBeInTheDocument()
  })

  it('renders "mount failed" instead of the success label when a mount has an error', () => {
    const attachment: MountAttachment = {
      type: 'mount',
      id: 'mount-1',
      folderName: 'my-data',
      hostPath: '/Users/joe/my-data',
      error: 'hostPath is required',
    }
    render(<AttachmentPreview attachments={[attachment]} onRemove={vi.fn()} />)
    expect(screen.getByText('mount failed')).toBeInTheDocument()
    expect(screen.getByText('mount failed')).toHaveAttribute('title', 'hostPath is required')
    expect(screen.queryByText('mounted, read-write')).not.toBeInTheDocument()
  })

  it('calls onRemove with mount id when remove button is clicked', async () => {
    const user = userEvent.setup()
    const onRemove = vi.fn()
    const attachment: MountAttachment = {
      type: 'mount',
      id: 'mount-42',
      folderName: 'test-mount',
      hostPath: '/tmp/test',
    }
    render(<AttachmentPreview attachments={[attachment]} onRemove={onRemove} />)

    const removeButton = screen.getByRole('button')
    await user.click(removeButton)
    expect(onRemove).toHaveBeenCalledWith('mount-42')
  })

  it('renders mixed file, folder, and mount attachments', () => {
    const attachments: Attachment[] = [
      createAttachment({ id: 'f1', name: 'readme.md' }),
      createFolderAttachment({ id: 'd1', folderName: 'components' }),
      {
        type: 'mount',
        id: 'm1',
        folderName: 'workspace',
        hostPath: '/Users/joe/workspace',
      },
    ]
    render(<AttachmentPreview attachments={attachments} onRemove={vi.fn()} />)
    expect(screen.getByText('readme.md')).toBeInTheDocument()
    expect(screen.getByText('components')).toBeInTheDocument()
    expect(screen.getByText('workspace')).toBeInTheDocument()
    expect(screen.getByText('mounted, read-write')).toBeInTheDocument()
  })
})

describe('upload status', () => {
  it('queued shows "waiting" without a spinner', () => {
    render(<AttachmentPreview attachments={[createAttachment({ upload: { status: 'queued', agentSlug: 'a' } })]} onRemove={vi.fn()} />)
    const chip = screen.getByTestId('attachment-preview')
    expect(chip).toHaveAttribute('data-attachment-status', 'queued')
    expect(screen.getByText('waiting')).toBeInTheDocument()
    expect(chip.querySelector('.animate-spin')).toBeNull()
  })

  it('uploading with percent shows a bar and the size, no percent text', () => {
    render(<AttachmentPreview attachments={[createAttachment({ size: 2048, upload: { status: 'uploading', percent: 31, agentSlug: 'a' } })]} onRemove={vi.fn()} />)
    expect(screen.getByTestId('attachment-preview')).toHaveAttribute('data-attachment-status', 'uploading')
    expect(screen.getByTestId('attachment-progress')).toBeInTheDocument()
    expect(screen.getByText('2.0 KB')).toBeInTheDocument()
    expect(screen.queryByText(/31/)).toBeNull()
  })

  it('uploading without percent shows a spinner', () => {
    render(<AttachmentPreview attachments={[createFolderAttachment({ upload: { status: 'uploading', agentSlug: 'a' } })]} onRemove={vi.fn()} />)
    expect(screen.getByTestId('attachment-preview').querySelector('.animate-spin')).not.toBeNull()
  })

  it('done shows a check', () => {
    render(<AttachmentPreview attachments={[createAttachment({ upload: { status: 'done', path: '/p', agentSlug: 'a' } })]} onRemove={vi.fn()} />)
    expect(screen.getByTestId('attachment-preview')).toHaveAttribute('data-attachment-status', 'done')
    expect(screen.getByTestId('attachment-done')).toBeInTheDocument()
  })

  it('error shows the reason on hover and a retry control', async () => {
    const onRetry = vi.fn()
    render(<AttachmentPreview attachments={[createAttachment({ id: 'x', error: 'Upload stalled for 30 seconds. Check your connection and retry.' })]} onRemove={vi.fn()} onRetry={onRetry} />)
    const chip = screen.getByTestId('attachment-preview')
    expect(chip).toHaveAttribute('data-attachment-status', 'error')
    expect(chip).toHaveAttribute('data-attachment-error', 'Upload stalled for 30 seconds. Check your connection and retry.')
    expect(screen.getByText('upload failed')).toHaveAttribute('title', 'Upload stalled for 30 seconds. Check your connection and retry.')
    await userEvent.click(screen.getByRole('button', { name: 'retry' }))
    expect(onRetry).toHaveBeenCalledWith('x')
  })

  it('a chip with neither field has no status attribute (mount, pre-upload)', () => {
    render(<AttachmentPreview attachments={[createAttachment()]} onRemove={vi.fn()} />)
    expect(screen.getByTestId('attachment-preview')).not.toHaveAttribute('data-attachment-status')
  })
})

