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

  it('closes an open box on Escape pressed outside it', () => {
    render(<ImageRenderer url="/shot.png" filePath="/workspace/shot.png" agentSlug="test-agent" />)
    fireEvent.click(screen.getByRole('img'))
    expect(screen.getByPlaceholderText('Add your comment...')).toBeVisible()

    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(screen.queryByPlaceholderText('Add your comment...')).not.toBeInTheDocument()
  })
})
