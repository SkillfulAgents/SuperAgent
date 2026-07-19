// @vitest-environment jsdom

import { useEffect } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { CommentBar } from './comment-bar'
import type { FileComment } from '@renderer/context/file-preview-context'
import { useDraft } from '@renderer/context/drafts-context'
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

describe('CommentBar feedback submission', () => {
  it('appends feedback to the session composer draft without sending a message', async () => {
    const sessionId = 'session-1'
    const comments: FileComment[] = [{
      id: 'comment-1',
      filePath: '/workspace/report.md',
      text: 'Clarify this conclusion',
      selectedText: 'Results were mixed',
    }]

    renderWithProviders(
      <>
        <DraftProbe sessionId={sessionId} initialDraft="Existing note" />
        <input data-testid="message-input" aria-label="Message composer" />
        <CommentBar
          comments={comments}
          filePath="/workspace/report.md"
          sessionId={sessionId}
        />
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
})
