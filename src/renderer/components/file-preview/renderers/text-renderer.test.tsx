// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TextRenderer } from './text-renderer'

const { file } = vi.hoisted(() => ({
  file: { text: 'first line\nsecond line', comments: [] as { anchor: unknown }[] },
}))

vi.mock('./use-file-content', () => ({
  useFileContent: () => ({ data: { text: file.text, truncated: false }, isLoading: false, error: null }),
}))

vi.mock('@renderer/context/file-preview-context', () => ({
  useFilePreview: () => ({ commentsFor: () => file.comments, addComment: vi.fn(), commentsEnabled: true }),
}))
vi.mock('@renderer/hooks/use-voice-input', () => ({
  useVoiceInput: () => ({ isRecording: false, isConnecting: false, isFinalizing: false, isSupported: true, error: null, clearError: () => {}, startRecording: async () => {}, stopRecording: async () => undefined }),
  useIsVoiceConfigured: () => true,
}))
vi.mock('@renderer/components/ui/voice-input-button', () => ({ VoiceInputButton: () => null, VoiceInputError: () => null }))

describe('TextRenderer', () => {
  it('makes file contents selectable without including line numbers', () => {
    render(<TextRenderer url="/file.txt" filePath="/file.txt" agentSlug="test-agent" />)

    expect(screen.getByText('first line')).toHaveClass('select-text')
    expect(screen.getByText('1')).toHaveClass('select-none')
  })

  it('comments on the line under the mouse when C is pressed', () => {
    render(<TextRenderer url="/file.txt" filePath="/file.txt" agentSlug="test-agent" />)

    fireEvent.pointerMove(screen.getByText('second line'))
    fireEvent.keyDown(window, { key: 'c' })

    expect(screen.getByText('Line 2: > "second line"')).toBeVisible()
    expect(screen.getByPlaceholderText('Add your comment...')).toBeVisible()
  })

  it('offers the chip for a selection made in the file, and not after a press elsewhere', async () => {
    // jsdom has no layout for ranges.
    Object.defineProperty(Range.prototype, 'getClientRects', { value: () => [], configurable: true })
    render(<TextRenderer url="/file.txt" filePath="/file.txt" agentSlug="test-agent" />)
    const selectFrom = (pressed: Element, node: Node) => {
      fireEvent.mouseDown(pressed)
      const range = document.createRange()
      range.selectNodeContents(node)
      window.getSelection()!.removeAllRanges()
      window.getSelection()!.addRange(range)
      fireEvent.mouseUp(window)
    }
    // The chip opens a frame after mouseup: let it render before checking.
    const frame = () => act(() => new Promise(resolve => requestAnimationFrame(resolve)))
    const line = screen.getByText('second line')
    const outside = document.body.appendChild(document.createElement('p'))
    outside.textContent = 'elsewhere'

    selectFrom(outside, outside)
    await frame()
    expect(screen.queryByRole('button', { name: 'Comment' })).not.toBeInTheDocument()

    selectFrom(line, line)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Comment' })).toBeVisible())

    // A press elsewhere (a button keeps the selection live) closes the chip, and its mouseup does not reopen it.
    fireEvent.mouseDown(outside)
    fireEvent.mouseUp(window)
    await frame()
    expect(screen.queryByRole('button', { name: 'Comment' })).not.toBeInTheDocument()

    // So does a press on the line gutter, inside the file but not selectable.
    selectFrom(line, line)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Comment' })).toBeVisible())
    const gutter = screen.getByText('2')
    gutter.style.userSelect = 'none'
    fireEvent.mouseDown(gutter)
    fireEvent.mouseUp(window)
    await frame()
    expect(screen.queryByRole('button', { name: 'Comment' })).not.toBeInTheDocument()

    // Selecting in the file again offers it.
    selectFrom(line, line)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Comment' })).toBeVisible())
  })

  it('keeps the pin on a line when the file refreshes, and removes it cleanly', () => {
    file.comments = [{ anchor: { kind: 'text', quote: 'second line', lines: { start: 2, end: 2 } } }]
    const view = render(<TextRenderer url="/file.txt" filePath="/file.txt" agentSlug="test-agent" />)
    expect(screen.getByText('second line').closest('td')).toHaveTextContent('1')

    file.text = 'first line\nsecond line, edited'
    view.rerender(<TextRenderer url="/file.txt" filePath="/file.txt" agentSlug="test-agent" />)
    expect(screen.getByText('second line, edited').closest('td')).toHaveTextContent('1')

    file.comments = []
    expect(() => view.rerender(<TextRenderer url="/file.txt" filePath="/file.txt" agentSlug="test-agent" />)).not.toThrow()
    expect(screen.getByText('second line, edited').closest('td')).not.toHaveTextContent('1')
    file.text = 'first line\nsecond line'
  })
})
