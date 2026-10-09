// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { FileComment } from '@renderer/context/file-preview-context'
import { AudioRenderer } from './audio-renderer'
import { FileRenderer } from './file-renderer'

const addComment = vi.fn()
let comments = new Map<string, FileComment[]>()

// The comment box's mic needs app providers; the player only decides whether it listens.
const startRecording = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('@renderer/hooks/use-voice-input', () => ({
  useVoiceInput: () => ({ isRecording: false, isConnecting: false, isFinalizing: false, isSupported: true, error: null, clearError: () => {}, startRecording, stopRecording: async () => undefined }),
  useIsVoiceConfigured: () => true,
}))
vi.mock('@renderer/components/ui/voice-input-button', () => ({ VoiceInputButton: () => null, VoiceInputError: () => null }))

vi.mock('@renderer/context/file-preview-context', () => ({
  useFilePreview: () => ({
    commentsFor: (filePath: string, agentSlug: string) => comments.get(`${agentSlug}:${filePath}`) ?? [],
    addComment,
  }),
}))

beforeEach(() => {
  comments = new Map()
  addComment.mockReset()
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Audio decoding unavailable in jsdom')))
  vi.spyOn(console, 'debug').mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('AudioRenderer', () => {
  it('hides annotation controls in a read-only preview', () => {
    render(
      <AudioRenderer
        url="/voice-note.mp3"
        filePath="/workspace/voice-note.mp3"
        agentSlug="test-agent"
        commentsEnabled={false}
      />,
    )

    expect(screen.queryByTestId('audio-add-comment')).not.toBeInTheDocument()
    expect(fireEvent.keyDown(window, { key: 'c' })).toBe(true)
    expect(HTMLMediaElement.prototype.pause).not.toHaveBeenCalled()
    expect(screen.queryByPlaceholderText('Add your comment...')).not.toBeInTheDocument()
  })

  it('renders custom playback controls and a waveform timeline', () => {
    render(<AudioRenderer url="/voice-note.mp3" filePath="/workspace/voice-note.mp3" agentSlug="test-agent" />)

    expect(screen.getByTestId('audio-element')).toBeInTheDocument()
    expect(screen.getByTestId('audio-waveform')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Play' })).toBeVisible()
    expect(screen.getByTestId('audio-add-comment')).toBeVisible()
    expect(screen.getByText('voice-note.mp3')).toBeVisible()
  })

  it('uses one inset coordinate layer for the waveform and playhead', () => {
    render(<AudioRenderer url="/voice-note.mp3" filePath="/workspace/voice-note.mp3" agentSlug="test-agent" />)

    const audio = screen.getByTestId('audio-element') as HTMLAudioElement
    Object.defineProperty(audio, 'duration', { configurable: true, value: 120 })
    fireEvent.loadedMetadata(audio)
    audio.currentTime = 60
    fireEvent.timeUpdate(audio)

    const timeline = screen.getByTestId('audio-timeline')
    const playhead = screen.getByTestId('audio-playhead')
    expect(timeline.querySelector('svg')).toBeInTheDocument()
    expect(timeline).toContainElement(playhead)
    expect(timeline).toContainElement(screen.getByTestId('audio-seek'))
    expect(playhead).toHaveStyle({ left: '50%' })
    expect(screen.getByTestId('audio-waveform-progress')).toHaveAttribute('offset', '50%')
  })

  it('waits for metadata before fetching audio for waveform decoding', () => {
    render(<AudioRenderer url="/voice-note.mp3" filePath="/workspace/voice-note.mp3" agentSlug="test-agent" />)
    expect(fetch).not.toHaveBeenCalled()

    const audio = screen.getByTestId('audio-element') as HTMLAudioElement
    Object.defineProperty(audio, 'duration', { configurable: true, value: 60 })
    fireEvent.loadedMetadata(audio)

    expect(fetch).toHaveBeenCalledOnce()
  })

  it('skips waveform decoding for long recordings', () => {
    render(<AudioRenderer url="/long-recording.mp3" filePath="/workspace/long-recording.mp3" agentSlug="test-agent" />)

    const audio = screen.getByTestId('audio-element') as HTMLAudioElement
    Object.defineProperty(audio, 'duration', { configurable: true, value: 20 * 60 })
    fireEvent.loadedMetadata(audio)

    expect(fetch).not.toHaveBeenCalled()
  })

  it('shows an add-comment affordance when the waveform is hovered', () => {
    render(<AudioRenderer url="/voice-note.mp3" filePath="/workspace/voice-note.mp3" agentSlug="test-agent" />)

    fireEvent.pointerMove(screen.getByTestId('audio-waveform'), { clientX: 40 })

    expect(screen.getByTestId('audio-hover-add-comment')).toBeVisible()
    expect(screen.getByText('0:00.00', { selector: 'div.text-center' })).toBeVisible()
  })

  it('keeps the hover affordance open while the pointer moves to it', () => {
    vi.useFakeTimers()
    render(<AudioRenderer url="/voice-note.mp3" filePath="/workspace/voice-note.mp3" agentSlug="test-agent" />)

    const waveform = screen.getByTestId('audio-waveform')
    fireEvent.pointerMove(waveform, { clientX: 40 })
    const hoverComment = screen.getByTestId('audio-hover-add-comment')

    fireEvent.pointerLeave(waveform)
    expect(hoverComment).toBeVisible()
    fireEvent.pointerEnter(hoverComment)
    act(() => vi.advanceTimersByTime(300))

    expect(hoverComment).toBeVisible()
  })

  it('samples the media clock every animation frame while playing', () => {
    let nextFrame: FrameRequestCallback | undefined
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      nextFrame = callback
      return 1
    })
    vi.stubGlobal('requestAnimationFrame', requestFrame)
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    render(<AudioRenderer url="/voice-note.mp3" filePath="/workspace/voice-note.mp3" agentSlug="test-agent" />)

    const audio = screen.getByTestId('audio-element') as HTMLAudioElement
    Object.defineProperty(audio, 'paused', { configurable: true, value: false })
    Object.defineProperty(audio, 'ended', { configurable: true, value: false })
    audio.currentTime = 4.5
    fireEvent.play(audio)

    expect(requestFrame).toHaveBeenCalledOnce()
    act(() => nextFrame?.(16))

    expect(screen.getByText('0:04 / 0:00')).toBeVisible()
    expect(requestFrame).toHaveBeenCalledTimes(2)
  })

  it('plays, seeks, changes speed and comments from the keyboard, but not while typing', async () => {
    const user = userEvent.setup()
    render(<AudioRenderer url="/voice-note.mp3" filePath="/workspace/voice-note.mp3" agentSlug="test-agent" />)
    const audio = screen.getByTestId('audio-element') as HTMLAudioElement
    Object.defineProperty(audio, 'duration', { configurable: true, value: 120 })
    fireEvent.loadedMetadata(audio)
    audio.currentTime = 60

    await user.keyboard('l')
    expect(audio.currentTime).toBe(70)
    await user.keyboard('>')
    expect(audio.playbackRate).toBe(1.25)
    expect(screen.getByTestId('playback-speed')).toHaveTextContent('1.25×')
    await user.keyboard(' ')
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledOnce()

    await user.keyboard('c')
    const box = screen.getByPlaceholderText('Add your comment...')
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled()
    await user.type(box, 'kl ')
    expect(box).toHaveValue('kl ')
    expect(audio.currentTime).toBe(70)
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledOnce()
    await user.click(screen.getByRole('button', { name: 'Add' }))
    expect(addComment).toHaveBeenCalledWith(expect.objectContaining({ anchor: { kind: 'time', seconds: 70 } }))
  })

  it('sets the speed from the picker, and keys inside the open picker stay there', async () => {
    HTMLElement.prototype.hasPointerCapture = () => false
    HTMLElement.prototype.scrollIntoView = () => {}
    const user = userEvent.setup()
    render(<AudioRenderer url="/voice-note.mp3" filePath="/workspace/voice-note.mp3" agentSlug="test-agent" />)
    const audio = screen.getByTestId('audio-element') as HTMLAudioElement
    Object.defineProperty(audio, 'duration', { configurable: true, value: 120 })
    fireEvent.loadedMetadata(audio)
    audio.currentTime = 60

    await user.click(screen.getByTestId('playback-speed'))
    await user.keyboard('j')
    expect(audio.currentTime).toBe(60)
    await user.click(screen.getByRole('option', { name: '2×' }))
    expect(audio.playbackRate).toBe(2)
  })

  it('pauses playback and saves the locked timestamp when adding a comment', async () => {
    const user = userEvent.setup()
    render(<AudioRenderer url="/voice-note.mp3" filePath="/workspace/voice-note.mp3" agentSlug="test-agent" />)

    await user.click(screen.getByTestId('audio-add-comment'))

    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled()
    expect(screen.getByText('At 0:00.00')).toBeVisible()

    await user.type(screen.getByPlaceholderText('Add your comment...'), 'Reduce the background noise')
    // Add Comment opens a plain box; only M opens one listening.
    expect(startRecording).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Add' }))

    expect(addComment).toHaveBeenCalledWith({
      filePath: '/workspace/voice-note.mp3',
      agentSlug: 'test-agent',
      text: 'Reduce the background noise',
      anchor: { kind: 'time', seconds: 0 },
    })
  })

  it('renders existing timestamp comments as waveform markers', () => {
    comments.set('test-agent:/workspace/voice-note.mp3', [{
      id: 'comment-1',
      filePath: '/workspace/voice-note.mp3',
      agentSlug: 'test-agent',
      text: 'Cut this section',
      anchor: { kind: 'time', seconds: 12 },
    }])

    render(<AudioRenderer url="/voice-note.mp3" filePath="/workspace/voice-note.mp3" agentSlug="test-agent" />)

    expect(screen.getByRole('button', { name: 'Seek to comment 1 at 0:12.00' })).toBeVisible()
  })

  it('mutes and sets the volume on the audio element', () => {
    render(<AudioRenderer url="/voice-note.mp3" filePath="/workspace/voice-note.mp3" agentSlug="test-agent" />)
    const audio = screen.getByTestId('audio-element') as HTMLAudioElement

    fireEvent.click(screen.getByRole('button', { name: 'Mute' }))
    expect(audio.muted).toBe(true)

    fireEvent.change(screen.getByLabelText('Volume'), { target: { value: '0.6' } })
    expect(audio.volume).toBeCloseTo(0.6)
    expect(audio.muted).toBe(false)
  })

  it('clears media state when switching between audio files', async () => {
    const user = userEvent.setup()
    const { rerender } = render(
      <FileRenderer
        filePath="/workspace/a.mp3"
        fileUrl="/files/a.mp3"
        agentSlug="agent-1"
        pdfPage={1}
        onPdfPageChange={vi.fn()}
      />,
    )

    await user.click(screen.getByTestId('audio-add-comment'))
    expect(screen.getByPlaceholderText('Add your comment...')).toBeVisible()

    rerender(
      <FileRenderer
        filePath="/workspace/b.mp3"
        fileUrl="/files/b.mp3"
        agentSlug="agent-1"
        pdfPage={1}
        onPdfPageChange={vi.fn()}
      />,
    )

    expect(screen.queryByPlaceholderText('Add your comment...')).not.toBeInTheDocument()
    expect(screen.getByText('b.mp3')).toBeVisible()
  })
})
