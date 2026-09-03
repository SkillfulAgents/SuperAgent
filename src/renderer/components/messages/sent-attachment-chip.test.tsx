// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SentAttachmentChip, imageSizeForCount, isImageAttachment } from './sent-attachment-chip'

const openFile = vi.fn()
const openFolder = vi.fn()
let sizeBytes: number | null = 2048

vi.mock('@renderer/context/file-preview-context', () => ({
  useFilePreview: () => ({ openFile, openFolder }),
}))
vi.mock('@renderer/lib/env', () => ({ getApiBaseUrl: () => 'http://api.test' }))
vi.mock('@renderer/hooks/use-file-size', () => ({ useFileSize: () => ({ data: sizeBytes }) }))

describe('isImageAttachment', () => {
  it('is true for image extensions and false for other files and folders', () => {
    expect(isImageAttachment('/workspace/uploads/1-photo.PNG')).toBe(true)
    expect(isImageAttachment('/workspace/uploads/1-photo.webp')).toBe(true)
    expect(isImageAttachment('/workspace/uploads/1-report.pdf')).toBe(false)
    expect(isImageAttachment('/workspace/uploads/1-shots/')).toBe(false)
  })
})

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
    expect(chip).toHaveTextContent('report.pdf')
    expect(chip).toHaveTextContent('2.0 KB')
    expect(chip.querySelector('[data-file-icon-size]')).not.toBeNull()
    fireEvent.click(chip)
    expect(openFile).toHaveBeenCalledWith('/workspace/uploads/1788459888315-report.pdf', 'a1')
  })

  it('renders an image at native aspect ratio with a height cap, name only for assistive tech', () => {
    render(<SentAttachmentChip filePath="/workspace/uploads/1788459888336-photo.png" agentSlug="a1" />)
    const chip = screen.getByTestId('file-pill')
    expect(chip).toHaveAttribute('data-attachment-kind', 'image')
    const img = screen.getByAltText('photo.png')
    expect(img).toHaveAttribute('src', 'http://api.test/api/agents/a1/files/uploads/1788459888336-photo.png?inline=true')
    expect(img.className).toContain('max-h-64')
    expect(img.className).toContain('max-w-full')
    expect(img.className).not.toContain('object-cover')
    expect(chip).toHaveAttribute('data-image-size', 'single')
    expect(chip).toHaveAttribute('title', 'photo.png · 2.0 KB')
    expect(chip.querySelector('.sr-only')).toHaveTextContent('photo.png')
    expect(chip.querySelector('[data-file-icon-size]')).toBeNull()
  })

  it('renders a grid image as a cropped square tile', () => {
    render(<SentAttachmentChip filePath="/workspace/uploads/1788459888336-photo.png" agentSlug="a1" imageSize="grid" />)
    const chip = screen.getByTestId('file-pill')
    expect(chip.className).toContain('aspect-square')
    const img = screen.getByAltText('photo.png')
    expect(img.className).toContain('object-cover')
    expect(img.className).toContain('h-full w-full')
    expect(chip).toHaveAttribute('data-image-size', 'grid')
  })

  it('renders a folder with the folder tile and opens the folder browser', () => {
    sizeBytes = null
    render(<SentAttachmentChip filePath="/workspace/uploads/1788459888315-my-project/" agentSlug="a1" />)
    const chip = screen.getByTestId('file-pill')
    expect(chip).toHaveAttribute('data-attachment-kind', 'folder')
    expect(chip).toHaveTextContent('my-project')
    expect(chip.querySelector('svg.lucide-folder')).not.toBeNull()
    fireEvent.keyDown(chip, { key: 'Enter' })
    expect(openFolder).toHaveBeenCalledWith('/workspace/uploads/1788459888315-my-project/', 'a1')
    expect(openFile).not.toHaveBeenCalled()
  })
})
