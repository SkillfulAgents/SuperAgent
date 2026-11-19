// @vitest-environment jsdom
import { useMemo, useRef } from 'react'
import { act, fireEvent, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { FilePreviewProvider, useFilePreview, type FileCommentContent } from '@renderer/context/file-preview-context'
import { renderWithProviders as render } from '@renderer/test/test-utils'
import { useCommentBox } from './use-comment-box'
import type { CommentSurface } from './kinds'

/** A viewer of one line of text, or of a whole file when `whole`, as the drawer's renderers set themselves up. */
function Viewer({ name, whole = false, onAdd }: { name: string; whole?: boolean; onAdd?: (comment: FileCommentContent) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const surface = useMemo<CommentSurface>(() => (whole ? {} : { text: { blocks: ref }, file: null }), [whole])
  const { box } = useCommentBox(ref, surface, `/${name}.md`, 'agent', onAdd)
  const { commentsFor } = useFilePreview()
  return (
    <div ref={ref} data-testid={name} data-stored={commentsFor(`/${name}.md`, 'agent').length}>
      {!whole && <p data-comment-lines="3-3"><span>{name} line</span></p>}
      {box}
    </div>
  )
}

const BOX = 'Add your comment...'

describe('useCommentBox with several viewers on a page', () => {
  it('gives the key to the viewer under the mouse, though a whole-file viewer mounted first', () => {
    render(<FilePreviewProvider commentsEnabled><Viewer name="drawer" whole /><Viewer name="card" /></FilePreviewProvider>)
    fireEvent.pointerMove(screen.getByText('card line'))
    fireEvent.keyDown(document.body, { key: 'c' })
    expect(screen.getAllByPlaceholderText(BOX)).toHaveLength(1)
    expect(within(screen.getByTestId('card')).getByText('Line 3: > "card line"')).toBeInTheDocument()
  })

  it('leaves a key from nowhere to a whole-file viewer mounted after one that turns the whole file off', () => {
    render(<FilePreviewProvider commentsEnabled><Viewer name="card" /><Viewer name="drawer" whole /></FilePreviewProvider>)
    fireEvent.pointerMove(document.body)
    fireEvent.keyDown(document.body, { key: 'c' })
    expect(within(screen.getByTestId('drawer')).getByText('Whole file')).toBeInTheDocument()
    expect(within(screen.getByTestId('card')).queryByPlaceholderText(BOX)).toBeNull()
  })

  it('hands an added comment to onAdd, numbers none and keeps none in the file list', async () => {
    const onAdd = vi.fn()
    render(<FilePreviewProvider commentsEnabled><Viewer name="card" onAdd={onAdd} /></FilePreviewProvider>)
    fireEvent.pointerMove(screen.getByText('card line'))
    fireEvent.keyDown(document.body, { key: 'c' })
    const box = screen.getByPlaceholderText(BOX)
    // The line is marked, with no number: there is no list to number it in.
    expect(screen.getByTestId('card').querySelector('[data-comment-marker]')).toBeEmptyDOMElement()
    fireEvent.change(box, { target: { value: 'Tighten this.' } })
    await act(async () => { fireEvent.keyDown(box, { key: 'Enter' }) })
    expect(onAdd).toHaveBeenCalledWith({ anchor: { kind: 'text', quote: 'card line', lines: { start: 3, end: 3 } }, text: 'Tighten this.' })
    expect(screen.getByTestId('card')).toHaveAttribute('data-stored', '0')
    expect(screen.queryByPlaceholderText(BOX)).toBeNull()
  })
})
