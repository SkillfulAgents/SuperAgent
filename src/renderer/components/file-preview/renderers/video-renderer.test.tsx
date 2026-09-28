// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { VideoRenderer } from './video-renderer'

vi.mock('@renderer/context/file-preview-context', () => ({
  useFilePreview: () => ({ commentsFor: () => [], addComment: vi.fn() }),
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
