// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { VideoRenderer } from './video-renderer'

// The comment box's mic needs app providers; the player only decides whether it listens.
const startRecording = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('@renderer/hooks/use-voice-input', () => ({
  useVoiceInput: () => ({ isRecording: false, isConnecting: false, isFinalizing: false, isSupported: true, error: null, clearError: () => {}, startRecording, stopRecording: async () => undefined }),
  useIsVoiceConfigured: () => true,
}))
vi.mock('@renderer/components/ui/voice-input-button', () => ({ VoiceInputButton: () => null, VoiceInputError: () => null }))

vi.mock('@renderer/context/file-preview-context', () => ({
  useFilePreview: () => ({ commentsFor: () => [], addComment: vi.fn(), commentsEnabled: true }),
}))

afterEach(() => vi.restoreAllMocks())

describe('VideoRenderer keys', () => {
  it('opens a comment with C at the mouse position over the frame', () => {
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    render(<VideoRenderer url="/clip.mp4" filePath="/workspace/clip.mp4" agentSlug="test-agent" />)
    const frame = screen.getByTestId('video-element').parentElement!
    vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 200, 100))

    // jsdom has no PointerEvent; React reads clientX from any 'pointermove' event.
    frame.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 50, clientY: 30 }))
    fireEvent.keyDown(window, { key: 'c' })

    expect(screen.getByText('(25%, 30%)', { exact: false })).toBeInTheDocument()
  })

  it('comments at the hovered time with C over the scrubber, with no point on the frame', () => {
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    render(<VideoRenderer url="/clip.mp4" filePath="/workspace/clip.mp4" agentSlug="test-agent" />)
    const video = screen.getByTestId('video-element') as HTMLVideoElement
    Object.defineProperty(video, 'duration', { configurable: true, value: 40 })
    const seek = screen.getByRole('slider', { name: 'Seek' })
    const scrubber = seek.parentElement!
    vi.spyOn(scrubber, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 200, 20))

    seek.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 150, clientY: 10 }))
    fireEvent.keyDown(window, { key: 'c' })

    expect(screen.getByText('At 0:30.00')).toBeInTheDocument()
  })

  it('opens a listening comment with M, a plain one with C', async () => {
    startRecording.mockClear()
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    render(<VideoRenderer url="/clip.mp4" filePath="/workspace/clip.mp4" agentSlug="test-agent" />)
    fireEvent.keyDown(window, { key: 'c' })
    await act(() => new Promise((resolve) => setTimeout(resolve)))
    expect(startRecording).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.keyDown(window, { key: 'm' })
    await waitFor(() => expect(startRecording).toHaveBeenCalledTimes(1))
  })

  it('keeps a half-typed comment open through Play and clicks outside the frame', () => {
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
    render(<VideoRenderer url="/clip.mp4" filePath="/workspace/clip.mp4" agentSlug="test-agent" />)
    fireEvent.keyDown(window, { key: 'c' })
    fireEvent.change(screen.getByPlaceholderText('Add your comment...'), { target: { value: 'trim here' } })

    fireEvent.click(screen.getByRole('button', { name: 'Play' }))
    fireEvent.click(screen.getByTestId('video-renderer'))
    fireEvent.click(document.body)
    expect(screen.getByPlaceholderText('Add your comment...')).toHaveValue('trim here')
  })

  it('measures a frame from frames shown, never across a seek', () => {
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    render(<VideoRenderer url="/clip.mp4" filePath="/workspace/clip.mp4" agentSlug="test-agent" />)
    const video = screen.getByTestId('video-element') as HTMLVideoElement
    let onFrame: VideoFrameRequestCallback = () => {}
    Object.assign(video, {
      requestVideoFrameCallback: (cb: VideoFrameRequestCallback) => { onFrame = cb; return 1 },
      cancelVideoFrameCallback: () => {},
    })
    const frame = (mediaTime: number, presentedFrames: number) =>
      onFrame(0, { mediaTime, presentedFrames, width: 0, height: 0, expectedDisplayTime: 0, presentationTime: 0 })
    fireEvent.play(video)

    frame(1, 10)
    fireEvent(video, new Event('seeking'))
    frame(1.01, 13) // spans the seek: ignored
    frame(1.01 + 1 / 24, 14)

    video.currentTime = 2
    fireEvent.keyDown(window, { key: '.' })
    expect(video.currentTime).toBeCloseTo(2 + 1 / 24, 6)
  })

  it('steps 1/30 s while playing where the browser cannot report frames', () => {
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    render(<VideoRenderer url="/clip.mp4" filePath="/workspace/clip.mp4" agentSlug="test-agent" />)
    const video = screen.getByTestId('video-element') as HTMLVideoElement
    expect('requestVideoFrameCallback' in video).toBe(false)
    fireEvent.play(video)
    video.currentTime = 1

    fireEvent.keyDown(window, { key: '.' })
    expect(video.currentTime).toBeCloseTo(1 + 1 / 30, 6)
  })
})

describe('VideoRenderer volume', () => {
  it('mutes, unmutes and sets the volume on the video element', () => {
    render(<VideoRenderer url="/clip.mp4" filePath="/workspace/clip.mp4" agentSlug="test-agent" />)
    const video = screen.getByTestId('video-element') as HTMLVideoElement

    fireEvent.click(screen.getByRole('button', { name: 'Mute' }))
    expect(video.muted).toBe(true)
    expect(screen.getByLabelText('Volume')).toHaveValue('0')

    fireEvent.click(screen.getByRole('button', { name: 'Unmute' }))
    expect(video.muted).toBe(false)

    fireEvent.change(screen.getByLabelText('Volume'), { target: { value: '0.4' } })
    expect(video.volume).toBeCloseTo(0.4)

    fireEvent.change(screen.getByLabelText('Volume'), { target: { value: '0' } })
    expect(video.muted).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Unmute' }))
    expect(video.muted).toBe(false)
    expect(video.volume).toBe(1)
  })
})
