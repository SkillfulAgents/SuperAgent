// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { CommentOverlay } from './comment-overlay'

const addComment = vi.hoisted(() => vi.fn())

vi.mock('@renderer/context/file-preview-context', () => ({
  useFilePreview: () => ({ addComment }),
}))

afterEach(() => addComment.mockClear())

describe('CommentOverlay', () => {
  it('adds on Enter, not on Shift+Enter', () => {
    render(
      <CommentOverlay
        selection={{ text: '', rect: new DOMRect() }}
        filePath="/workspace/clip.mp4"
        agentSlug="test-agent"
        onClose={() => {}}
        autoEdit
      />,
    )
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
      <CommentOverlay selection={{ text: '', rect: new DOMRect() }} filePath="/workspace/a.md" agentSlug="test-agent" onClose={onClose} autoEdit />,
    )
    const box = screen.getByPlaceholderText('Add your comment...')

    fireEvent.keyDown(box, { key: 'Escape', isComposing: true })
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.keyDown(box, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })
})
