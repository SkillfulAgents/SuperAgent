// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ImageRenderer } from './image-renderer'

vi.mock('@renderer/hooks/use-voice-input', () => ({
  useVoiceInput: () => ({ isRecording: false, isConnecting: false, isFinalizing: false, isSupported: true, error: null, clearError: () => {}, startRecording: async () => {}, stopRecording: async () => undefined }),
  useIsVoiceConfigured: () => true,
}))
vi.mock('@renderer/components/ui/voice-input-button', () => ({ VoiceInputButton: () => null, VoiceInputError: () => null }))
vi.mock('@renderer/context/file-preview-context', () => ({
  useFilePreview: () => ({ commentsFor: () => [], addComment: vi.fn(), commentsEnabled: true }),
}))

describe('ImageRenderer', () => {
  it('opens the comment box on the first click, at the clicked point', () => {
    render(<ImageRenderer url="/shot.png" filePath="/workspace/shot.png" agentSlug="test-agent" />)
    const image = screen.getByRole('img')
    image.parentElement!.getBoundingClientRect = () => new DOMRect(0, 0, 200, 100)

    fireEvent.click(image, { clientX: 50, clientY: 25 })

    expect(screen.getByPlaceholderText('Add your comment...')).toBeVisible()
    expect(screen.getByText('At position (25%, 25%)')).toBeVisible()
  })

  it('replaces a failed image and its spinner with an unavailable message', () => {
    const { container } = render(<ImageRenderer url="/broken.heic" filePath="/workspace/broken.heic" agentSlug="test-agent" />)

    fireEvent.error(screen.getByRole('img'))

    expect(screen.getByText('Image preview unavailable')).toBeVisible()
    expect(container.querySelector('.animate-spin')).toBeNull()
  })

  it.each(['png', 'heic'])('retries a failed %s preview when the same file gets a new URL', (extension) => {
    const filePath = `/workspace/photo.${extension}`
    const { container, rerender } = render(
      <ImageRenderer url={`/photo.${extension}?v=1`} filePath={filePath} agentSlug="test-agent" />,
    )
    fireEvent.error(screen.getByRole('img'))
    expect(screen.getByText('Image preview unavailable')).toBeVisible()

    rerender(<ImageRenderer url={`/photo.${extension}?v=2`} filePath={filePath} agentSlug="test-agent" />)

    expect(screen.queryByText('Image preview unavailable')).not.toBeInTheDocument()
    expect(screen.getByRole('img')).toHaveAttribute('src', `/photo.${extension}?v=2`)
    expect(container.querySelector('.animate-spin')).not.toBeNull()
    fireEvent.load(screen.getByRole('img'))
    expect(container.querySelector('.animate-spin')).toBeNull()
  })

  it('shows loading again when a previously loaded preview gets a new URL', () => {
    const { container, rerender } = render(
      <ImageRenderer url="/photo.png?v=1" filePath="/workspace/photo.png" agentSlug="test-agent" />,
    )
    fireEvent.load(screen.getByRole('img'))
    expect(container.querySelector('.animate-spin')).toBeNull()

    rerender(<ImageRenderer url="/photo.png?v=2" filePath="/workspace/photo.png" agentSlug="test-agent" />)

    expect(container.querySelector('.animate-spin')).not.toBeNull()
  })

  it('closes an open box on Escape pressed outside it', () => {
    render(<ImageRenderer url="/shot.png" filePath="/workspace/shot.png" agentSlug="test-agent" />)
    fireEvent.click(screen.getByRole('img'))
    expect(screen.getByPlaceholderText('Add your comment...')).toBeVisible()

    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(screen.queryByPlaceholderText('Add your comment...')).not.toBeInTheDocument()
  })
})
