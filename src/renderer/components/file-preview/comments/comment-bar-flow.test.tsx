// @vitest-environment jsdom

import { useEffect, useRef } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { CommentBar } from './comment-bar'
import { FilePreviewProvider, useFilePreview, type FileComment } from '@renderer/context/file-preview-context'
import { useDraft } from '@renderer/context/drafts-context'
import { registerSessionComposerFocus } from '@renderer/components/messages/composer-focus'
import { renderWithProviders, screen, waitFor, userEvent } from '@renderer/test/test-utils'

const sendMessage = vi.hoisted(() => vi.fn().mockResolvedValue({ success: true }))

vi.mock('@renderer/hooks/use-messages', () => ({
  useSendMessage: () => ({ mutateAsync: sendMessage, isPending: false }),
}))

function DraftProbe({ sessionId, initialDraft }: { sessionId: string; initialDraft?: string }) {
  const [draft, setDraft] = useDraft<string>(`session:${sessionId}`)

  useEffect(() => {
    if (initialDraft !== undefined) setDraft(initialDraft)
  }, [initialDraft, setDraft])

  return <output data-testid="draft-probe">{draft}</output>
}

/** Stands in for MessageInput: registers a focus handler like the real composer does. */
function ComposerProbe({ sessionId }: { sessionId: string }) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => registerSessionComposerFocus(sessionId, () => ref.current?.focus()), [sessionId])
  return <input ref={ref} data-testid="message-input" aria-label="Message composer" />
}

describe('CommentBar feedback submission', () => {
  it('appends feedback to the session composer draft without sending a message', async () => {
    const sessionId = 'session-1'
    const comments: FileComment[] = [{
      id: 'comment-1',
      filePath: '/workspace/report.md',
      agentSlug: 'test-agent',
      text: 'Clarify this conclusion',
      anchor: { kind: 'text', quote: 'Results were mixed' },
    }]

    renderWithProviders(
      <>
        <DraftProbe sessionId={sessionId} initialDraft="Existing note" />
        <ComposerProbe sessionId={sessionId} />
        <FilePreviewProvider commentsEnabled>
          <CommentBar
            comments={comments}
            filePath="/workspace/report.md"
            agentSlug="test-agent"
            sessionId={sessionId}
          />
        </FilePreviewProvider>
      </>,
    )

    await waitFor(() => expect(screen.getByTestId('draft-probe')).toHaveTextContent('Existing note'))
    await userEvent.click(screen.getByRole('button', { name: 'Submit' }))

    await waitFor(() => {
      expect(screen.getByTestId('draft-probe')).toHaveTextContent(
        'Existing note File feedback on `report.md`: > "Results were mixed" Clarify this conclusion',
      )
    })
    expect(sendMessage).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByTestId('message-input')).toHaveFocus())
  })

  it('hides Submit when access drops after comments were added, and keeps the comments', async () => {
    const sessionId = 'session-1'
    const filePath = '/workspace/report.md'
    function Bar() {
      const { addComment, commentsFor } = useFilePreview()
      const comments = commentsFor(filePath, 'test-agent')
      return (
        <>
          <button onClick={() => addComment({ filePath, agentSlug: 'test-agent', text: 'Added before access changed', anchor: { kind: 'text', quote: 'Results were mixed' } })}>Seed</button>
          <output data-testid="comment-count">{comments.length}</output>
          <CommentBar comments={comments} filePath={filePath} agentSlug="test-agent" sessionId={sessionId} />
        </>
      )
    }
    const tree = (enabled: boolean) => (
      <>
        <DraftProbe sessionId={sessionId} />
        <FilePreviewProvider sessionId={sessionId} commentsEnabled={enabled}><Bar /></FilePreviewProvider>
      </>
    )

    const { rerender } = renderWithProviders(tree(true))
    await userEvent.click(screen.getByRole('button', { name: 'Seed' }))
    expect(screen.getByRole('button', { name: 'Submit' })).toBeInTheDocument()

    rerender(tree(false))

    expect(screen.queryByRole('button', { name: 'Submit' })).toBeNull()
    expect(screen.getByTestId('comment-count')).toHaveTextContent('1')
    expect(screen.getByTestId('draft-probe')).toBeEmptyDOMElement()
  })
})
