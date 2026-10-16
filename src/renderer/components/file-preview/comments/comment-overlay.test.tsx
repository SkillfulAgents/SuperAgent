// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { setVoiceModeActive } from '@renderer/lib/voice-mode-handoff'
import { CommentOverlay } from './comment-overlay'

const addComment = vi.hoisted(() => vi.fn())
const voice = vi.hoisted(() => ({
  configured: true,
  isRecording: false,
  isConnecting: false,
  supported: true,
  isFinalizing: false,
  micDisabled: undefined as boolean | undefined,
  transcribe: (_text: string) => {},
  startRecording: vi.fn(async () => {}),
  stopRecording: vi.fn(async (): Promise<string | undefined> => undefined),
}))

vi.mock('@renderer/context/file-preview-context', () => ({
  useFilePreview: () => ({ addComment }),
}))
vi.mock('@renderer/hooks/use-voice-input', () => ({
  useVoiceInput: ({ onTranscriptUpdate }: { onTranscriptUpdate: (text: string) => void }) => {
    voice.transcribe = onTranscriptUpdate
    return {
      isRecording: voice.isRecording,
      isConnecting: voice.isConnecting,
      isFinalizing: voice.isFinalizing,
      isSupported: voice.supported,
      error: null,
      clearError: () => {},
      startRecording: voice.startRecording,
      stopRecording: voice.stopRecording,
    }
  },
  useIsVoiceConfigured: () => voice.configured,
}))
vi.mock('@renderer/components/ui/voice-input-button', () => ({
  VoiceInputButton: (props: { disabled?: boolean }) => { voice.micDisabled = props.disabled; return null },
  VoiceInputError: () => null,
}))

afterEach(() => {
  addComment.mockClear()
  voice.startRecording.mockClear()
  voice.stopRecording.mockReset()
  voice.isRecording = false
  voice.isConnecting = false
  voice.supported = true
  voice.isFinalizing = false
  voice.configured = true
  voice.micDisabled = undefined
  setVoiceModeActive('s1', false)
})

const open = (props: { autoListen?: boolean; onClose?: () => void } = {}) => render(
  <CommentOverlay anchor={{ kind: 'file' }} rect={new DOMRect()} filePath="/workspace/clip.mp4" agentSlug="test-agent" onClose={() => {}} autoEdit {...props} />,
)
// The mic starts a tick after the box opens.
const tick = () => act(() => new Promise((resolve) => setTimeout(resolve)))

describe('CommentOverlay', () => {
  it('heads the box with the anchor description', () => {
    render(<CommentOverlay anchor={{ kind: 'time', seconds: 4.2, point: { x: 40, y: 60 } }} rect={new DOMRect()} filePath="/workspace/clip.mp4" agentSlug="test-agent" onClose={() => {}} autoEdit />)
    expect(screen.getByText('At 0:04.20 at position (40%, 60%)')).toBeVisible()
  })

  it('adds on Enter, not on Shift+Enter', () => {
    render(
      <CommentOverlay
        anchor={{ kind: 'file' }} rect={new DOMRect()}
        filePath="/workspace/clip.mp4"
        agentSlug="test-agent"
        onClose={() => {}}
        autoEdit
      />,
    )
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled()
    const box = screen.getByPlaceholderText('Add your comment...')
    fireEvent.change(box, { target: { value: '日本' } })

    // fireEvent returns false when the default (the newline) is prevented.
    expect(fireEvent.keyDown(box, { key: 'Enter', shiftKey: true })).toBe(true)
    expect(addComment).not.toHaveBeenCalled()

    expect(fireEvent.keyDown(box, { key: 'Enter' })).toBe(false)
    expect(addComment).toHaveBeenCalledWith(expect.objectContaining({ text: '日本' }))
  })

  it('keeps the box open when Escape cancels an input-method candidate', () => {
    const onClose = vi.fn()
    render(
      <CommentOverlay anchor={{ kind: 'file' }} rect={new DOMRect()} filePath="/workspace/a.md" agentSlug="test-agent" onClose={onClose} autoEdit />,
    )
    const box = screen.getByPlaceholderText('Add your comment...')

    fireEvent.keyDown(box, { key: 'Escape', isComposing: true })
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.keyDown(box, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('adds the last spoken words when Enter arrives while recording', async () => {
    voice.isRecording = true
    voice.stopRecording.mockResolvedValue('trim the intro')
    open()

    await act(async () => { fireEvent.keyDown(screen.getByPlaceholderText('Add your comment...'), { key: 'Enter' }) })

    expect(voice.stopRecording).toHaveBeenCalled()
    expect(addComment).toHaveBeenCalledWith(expect.objectContaining({ text: 'trim the intro' }))
  })

  it('keeps typed text when the mic heard nothing', async () => {
    voice.isRecording = true
    voice.stopRecording.mockResolvedValue('')
    open()
    const box = screen.getByPlaceholderText('Add your comment...')
    fireEvent.change(box, { target: { value: 'trim the intro' } })

    act(() => voice.transcribe(''))
    expect(box).toHaveValue('trim the intro')
    await act(async () => { fireEvent.keyDown(box, { key: 'Enter' }) })
    expect(addComment).toHaveBeenCalledWith(expect.objectContaining({ text: 'trim the intro' }))
  })

  it('stops the mic on Escape from anywhere instead of closing the box', () => {
    // Still connecting counts: Escape during the sign-in round trip stops the mic too.
    voice.isConnecting = true
    const onClose = vi.fn()
    open({ onClose })
    const box = screen.getByPlaceholderText('Add your comment...')

    fireEvent.keyDown(box, { key: 'Escape' })
    expect(voice.stopRecording).toHaveBeenCalledTimes(1)

    // Focus elsewhere in the app still reaches it; an input method's Escape does not.
    fireEvent.keyDown(document.body, { key: 'Escape', isComposing: true })
    expect(voice.stopRecording).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(voice.stopRecording).toHaveBeenCalledTimes(2)
    // A dialog that stops Escape from bubbling still lets it reach the mic.
    const dialog = document.createElement('div')
    dialog.addEventListener('keydown', (e) => e.stopPropagation())
    document.body.appendChild(dialog)
    fireEvent.keyDown(dialog, { key: 'Escape' })
    dialog.remove()
    expect(voice.stopRecording).toHaveBeenCalledTimes(3)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes on an Escape the mic did not use, even while its last words arrive', () => {
    const onClose = vi.fn()
    const view = open({ onClose })
    const box = screen.getByPlaceholderText('Add your comment...')

    // The mic's listener stops recording and marks the Escape used.
    const used = (e: KeyboardEvent) => e.preventDefault()
    window.addEventListener('keydown', used, true)
    fireEvent.keyDown(box, { key: 'Escape' })
    window.removeEventListener('keydown', used, true)
    expect(onClose).not.toHaveBeenCalled()

    voice.isFinalizing = true
    view.rerender(<CommentOverlay anchor={{ kind: 'file' }} rect={new DOMRect()} filePath="/workspace/clip.mp4" agentSlug="test-agent" onClose={onClose} autoEdit />)
    // Adding now would drop the last words, so Add waits for them.
    fireEvent.change(box, { target: { value: 'trim' } })
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled()
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(addComment).not.toHaveBeenCalled()

    fireEvent.keyDown(box, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('drops the words when the box closes while Add waits for them', async () => {
    voice.isRecording = true
    let finish: (text: string) => void = () => {}
    voice.stopRecording.mockReturnValue(new Promise((resolve) => { finish = resolve }))
    const view = open()
    // Recording with nothing typed yet: Add is live, since words are coming.
    expect(screen.getByRole('button', { name: 'Add' })).toBeEnabled()

    fireEvent.keyDown(screen.getByPlaceholderText('Add your comment...'), { key: 'Enter' })
    view.unmount()
    await act(async () => finish('trim the intro'))
    expect(addComment).not.toHaveBeenCalled()
  })

  it('listens on open only when asked, and never while voice mode has the mic', async () => {
    open()
    await tick()
    expect(voice.startRecording).not.toHaveBeenCalled()

    open({ autoListen: true })
    await tick()
    expect(voice.startRecording).toHaveBeenCalledTimes(1)

    voice.startRecording.mockClear()
    voice.supported = false
    open({ autoListen: true })
    await tick()
    expect(voice.startRecording).not.toHaveBeenCalled()

    voice.supported = true
    setVoiceModeActive('s1', true)
    open({ autoListen: true })
    await tick()
    expect(voice.startRecording).not.toHaveBeenCalled()
  })

  it('stops dictating when voice mode turns on', () => {
    voice.isRecording = true
    open()
    expect(voice.stopRecording).not.toHaveBeenCalled()
    expect(voice.micDisabled).toBe(false)

    act(() => setVoiceModeActive('s1', true))
    expect(voice.stopRecording).toHaveBeenCalled()
    expect(voice.micDisabled).toBe(true)
  })

  it('never starts the mic when voice is set up after the box opened', async () => {
    voice.configured = false
    const view = open({ autoListen: true })
    voice.configured = true
    view.rerender(<CommentOverlay anchor={{ kind: 'file' }} rect={new DOMRect()} filePath="/workspace/clip.mp4" agentSlug="test-agent" onClose={() => {}} autoEdit autoListen />)
    await tick()
    expect(voice.startRecording).not.toHaveBeenCalled()
  })
})
