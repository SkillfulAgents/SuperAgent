// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SentAttachmentChip, imageSizeForCount } from './sent-attachment-chip'

const openFile = vi.fn()
const openFolder = vi.fn()
let sizeBytes: number | null = 2048

vi.mock('@renderer/context/file-preview-context', () => ({
  useFilePreview: () => ({ openFile, openFolder }),
}))
vi.mock('@renderer/lib/env', () => ({ getApiBaseUrl: () => 'http://api.test' }))
vi.mock('@renderer/hooks/use-file-size', () => ({ useFileSize: () => ({ data: sizeBytes }) }))

describe('imageSizeForCount', () => {
  it('is single for up to three images, grid beyond', () => {
    expect(imageSizeForCount(1)).toBe('single')
    expect(imageSizeForCount(3)).toBe('single')
    expect(imageSizeForCount(4)).toBe('grid')
    expect(imageSizeForCount(9)).toBe('grid')
  })
})

describe('SentAttachmentChip', () => {
  beforeEach(() => {
    openFile.mockClear()
    openFolder.mockClear()
    sizeBytes = 2048
  })

  it('renders a file as tile + clean name + size, and opens it on click', () => {
    render(<SentAttachmentChip filePath="/workspace/uploads/1788459888315-report.pdf" agentSlug="a1" />)
    const chip = screen.getByTestId('file-pill')
    expect(chip).toHaveAttribute('data-attachment-kind', 'file')
    expect(chip).toHaveTextContent('1788459888315-report.pdf')
    expect(chip).toHaveTextContent('2.0 KB')
    expect(chip.querySelector('[data-file-icon-size]')).not.toBeNull()
    fireEvent.click(chip)
    expect(openFile).toHaveBeenCalledWith('/workspace/uploads/1788459888315-report.pdf', 'a1')
  })

  it('renders an image at native aspect ratio with a height cap', () => {
    render(<SentAttachmentChip filePath="/workspace/uploads/1788459888336-photo.png" agentSlug="a1" />)
    const chip = screen.getByTestId('file-pill')
    expect(chip).toHaveAttribute('data-attachment-kind', 'image')
    const img = screen.getByAltText('1788459888336-photo.png')
    expect(img).toHaveAttribute('src', 'http://api.test/api/agents/a1/files/uploads/1788459888336-photo.png?inline=true')
    expect(img.className).toContain('max-h-64')
    expect(img.className).toContain('max-w-full')
    expect(img.className).not.toContain('object-cover')
    expect(chip).toHaveAttribute('data-image-size', 'single')
    expect(chip).toHaveAttribute('title', '1788459888336-photo.png · 2.0 KB')
    expect(chip.querySelector('[data-file-icon-size]')).toBeNull()
  })

  // `alt` already names the picture; a second sr-only copy had screen readers
  // read the filename twice for one image.
  it('names a sent image exactly once', () => {
    render(<SentAttachmentChip filePath="/workspace/uploads/1788459888336-photo.png" agentSlug="a1" />)
    // The picture carries no text node of its own, and no sr-only twin.
    expect(screen.queryAllByText('1788459888336-photo.png')).toHaveLength(0)
    expect(screen.getByTestId('file-pill').querySelector('.sr-only')).toBeNull()
    expect(screen.getAllByAltText('1788459888336-photo.png')).toHaveLength(1)
  })

  // A deleted or unreachable upload would otherwise leave an alt-text box, or a
  // blank square in a grid.
  it('falls back to the file chip when the picture cannot load', () => {
    render(<SentAttachmentChip filePath="/workspace/uploads/1788459888336-photo.png" agentSlug="a1" />)
    fireEvent.error(screen.getByAltText('1788459888336-photo.png'))

    const chip = screen.getByTestId('file-pill')
    expect(chip).toHaveAttribute('data-attachment-kind', 'file')
    expect(chip).toHaveTextContent('1788459888336-photo.png')
    expect(chip).toHaveTextContent('2.0 KB')
    expect(chip.querySelector('[data-file-icon-size]')).not.toBeNull()
    fireEvent.click(chip)
    expect(openFile).toHaveBeenCalledWith('/workspace/uploads/1788459888336-photo.png', 'a1')
  })

  // Originals are uploaded at full resolution and drawn into a 256px box or a
  // grid square, so a thread of them must not be fetched or decoded eagerly.
  it('defers loading and decoding of sent images', () => {
    render(<SentAttachmentChip filePath="/workspace/uploads/1788459888336-photo.png" agentSlug="a1" />)
    const img = screen.getByAltText('1788459888336-photo.png')
    expect(img).toHaveAttribute('loading', 'lazy')
    expect(img).toHaveAttribute('decoding', 'async')
  })

  it('renders a grid image as a cropped square tile', () => {
    render(<SentAttachmentChip filePath="/workspace/uploads/1788459888336-photo.png" agentSlug="a1" imageSize="grid" />)
    const chip = screen.getByTestId('file-pill')
    expect(chip.className).toContain('aspect-square')
    const img = screen.getByAltText('1788459888336-photo.png')
    expect(img.className).toContain('object-cover')
    expect(img.className).toContain('h-full w-full')
    expect(chip).toHaveAttribute('data-image-size', 'grid')
  })

  it('renders a folder with the folder tile and opens the folder browser', () => {
    sizeBytes = null
    render(<SentAttachmentChip filePath="/workspace/uploads/1788459888315-my-project/" agentSlug="a1" />)
    const chip = screen.getByTestId('file-pill')
    expect(chip).toHaveAttribute('data-attachment-kind', 'folder')
    expect(chip).toHaveTextContent('1788459888315-my-project')
    expect(chip.querySelector('svg.lucide-folder')).not.toBeNull()
    fireEvent.keyDown(chip, { key: 'Enter' })
    expect(openFolder).toHaveBeenCalledWith('/workspace/uploads/1788459888315-my-project/', 'a1')
    expect(openFile).not.toHaveBeenCalled()
  })
})
