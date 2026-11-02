// @vitest-environment jsdom

import { useEffect, useRef } from 'react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { fireEvent } from '@testing-library/react'
import { useDraft } from '@renderer/context/drafts-context'
import { registerSessionComposerFocus } from '@renderer/components/messages/composer-focus'
import { renderWithProviders, screen, userEvent, waitFor } from '@renderer/test/test-utils'
import { MessageContextMenu } from './message-context-menu'
import { formatReplies, MessageReplyProvider, useMessageReplies } from './use-message-replies'

vi.mock('@renderer/hooks/use-voice-input', () => ({
  useVoiceInput: () => ({ isRecording: false, isConnecting: false, isFinalizing: false, isSupported: true, error: null, clearError: () => {}, startRecording: async () => {}, stopRecording: async () => undefined }),
  useIsVoiceConfigured: () => true,
}))
vi.mock('@renderer/components/ui/voice-input-button', () => ({ VoiceInputButton: () => null, VoiceInputError: () => null }))

const sessionId = 'session-1'
const AGENT_TEXT = 'Use Durable Object SQLite, not D1.'
const USER_TEXT = 'Should we use D1?'

function Thread() {
  const ref = useRef<HTMLDivElement>(null)
  const composerRef = useRef<HTMLInputElement>(null)
  const { box, bar, action } = useMessageReplies(ref, sessionId, true)
  const [draft] = useDraft<string>(`session:${sessionId}`)
  useEffect(() => registerSessionComposerFocus(sessionId, () => composerRef.current?.focus()), [])
  return (
    <div ref={ref} className="relative">
      <MessageReplyProvider value={action}>
        <MessageContextMenu text={USER_TEXT}><div>{USER_TEXT}</div></MessageContextMenu>
        <MessageContextMenu text={AGENT_TEXT} canReply readAloud={{ active: false, onToggle: () => {} }}>
          <div>{AGENT_TEXT}</div>
        </MessageContextMenu>
      </MessageReplyProvider>
      {bar}
      <input ref={composerRef} aria-label="Message composer" />
      <output data-testid="draft">{draft}</output>
      {box}
    </div>
  )
}

function select(text: string) {
  const range = document.createRange()
  range.selectNodeContents(screen.getByText(text))
  window.getSelection()!.removeAllRanges()
  window.getSelection()!.addRange(range)
}

const menuItems = () => screen.getAllByRole('menuitem').map((item) => item.textContent)

beforeAll(() => {
  Object.defineProperty(Range.prototype, 'getClientRects', { value: () => [new DOMRect(10, 10, 80, 16)], configurable: true })
})

describe('useMessageReplies', () => {
  it('replies to selected agent text from the context menu, into the composer draft', async () => {
    renderWithProviders(<Thread />)

    select(AGENT_TEXT)
    fireEvent.contextMenu(screen.getByText(AGENT_TEXT))
    expect(menuItems()).toEqual(['Copy', 'Read aloud', 'Reply'])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reply' }))

    expect(screen.getByText('> "Use Durable Object SQLite, not D1."')).toBeVisible()
    await userEvent.type(screen.getByPlaceholderText('Add your reply...'), 'Why not D1?{Enter}')

    expect(screen.getByText('1 reply')).toBeVisible()
    expect(screen.getByTestId('draft')).toBeEmptyDOMElement()
    await userEvent.click(screen.getByRole('button', { name: 'Submit' }))

    expect(screen.getByTestId('draft')).toHaveTextContent('Replying to what you wrote: > "Use Durable Object SQLite, not D1." Why not D1?')
    expect(screen.queryByText('1 reply')).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByLabelText('Message composer')).toHaveFocus())
  })

  it('offers no Reply without a selection in that message', () => {
    renderWithProviders(<Thread />)

    fireEvent.contextMenu(screen.getByText(AGENT_TEXT))
    expect(screen.queryByRole('menuitem', { name: 'Reply' })).not.toBeInTheDocument()
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })

    select(USER_TEXT)
    fireEvent.contextMenu(screen.getByText(USER_TEXT))
    expect(screen.queryByRole('menuitem', { name: 'Reply' })).not.toBeInTheDocument()
  })
})

describe('formatReplies', () => {
  it('quotes each selection on one line, with the reply below it', () => {
    expect(formatReplies([
      { id: '1', quote: 'First line\nsecond line', text: 'Explain this' },
      { id: '2', quote: 'Ship it', text: 'Agreed' },
    ])).toBe('Replying to what you wrote:\n\n> "First line second line"\n\nExplain this\n\n> "Ship it"\n\nAgreed')
  })
})
