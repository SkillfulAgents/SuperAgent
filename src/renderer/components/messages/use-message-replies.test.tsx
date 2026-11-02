// @vitest-environment jsdom

import { useEffect, useRef } from 'react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { act, fireEvent } from '@testing-library/react'
import { useDraft } from '@renderer/context/drafts-context'
import { registerSessionComposerFocus } from '@renderer/components/messages/composer-focus'
import { renderWithProviders, screen, userEvent, waitFor } from '@renderer/test/test-utils'
import { formatReplies, useMessageReplies } from './use-message-replies'

vi.mock('@renderer/hooks/use-voice-input', () => ({
  useVoiceInput: () => ({ isRecording: false, isConnecting: false, isFinalizing: false, isSupported: true, error: null, clearError: () => {}, startRecording: async () => {}, stopRecording: async () => undefined }),
  useIsVoiceConfigured: () => true,
}))
vi.mock('@renderer/components/ui/voice-input-button', () => ({ VoiceInputButton: () => null, VoiceInputError: () => null }))

const sessionId = 'session-1'

function Thread() {
  const ref = useRef<HTMLDivElement>(null)
  const composerRef = useRef<HTMLInputElement>(null)
  const { box, bar } = useMessageReplies(ref, sessionId, true)
  const [draft] = useDraft<string>(`session:${sessionId}`)
  useEffect(() => registerSessionComposerFocus(sessionId, () => composerRef.current?.focus()), [])
  return (
    <div ref={ref} className="relative">
      <div>Should we use D1?</div>
      <div data-agent-reply="">Use Durable Object SQLite, not D1.</div>
      {bar}
      <input ref={composerRef} aria-label="Message composer" />
      <output data-testid="draft">{draft}</output>
      {box}
    </div>
  )
}

const frame = () => act(() => new Promise(resolve => requestAnimationFrame(resolve)))

async function select(text: string) {
  const range = document.createRange()
  range.selectNodeContents(screen.getByText(text))
  window.getSelection()!.removeAllRanges()
  window.getSelection()!.addRange(range)
  fireEvent.mouseDown(screen.getByText(text))
  fireEvent.mouseUp(window)
  await frame()
}

beforeAll(() => {
  Object.defineProperty(Range.prototype, 'getClientRects', { value: () => [new DOMRect(10, 10, 80, 16)], configurable: true })
})

describe('useMessageReplies', () => {
  it('puts a reply to selected agent text into the composer draft', async () => {
    renderWithProviders(<Thread />)

    await select('Use Durable Object SQLite, not D1.')
    await userEvent.click(screen.getByRole('button', { name: 'Reply' }))
    expect(screen.getByText('> "Use Durable Object SQLite, not D1."')).toBeVisible()
    await userEvent.type(screen.getByPlaceholderText('Add your reply...'), 'Why not D1?{Enter}')

    expect(screen.getByText('1 reply')).toBeVisible()
    expect(screen.getByTestId('draft')).toBeEmptyDOMElement()
    await userEvent.click(screen.getByRole('button', { name: 'Submit' }))

    expect(screen.getByTestId('draft')).toHaveTextContent('Replying to what you wrote: > "Use Durable Object SQLite, not D1." Why not D1?')
    expect(screen.queryByText('1 reply')).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByLabelText('Message composer')).toHaveFocus())
  })

  it('offers no reply on text outside agent messages', async () => {
    renderWithProviders(<Thread />)

    await select('Should we use D1?')

    expect(screen.queryByRole('button', { name: 'Reply' })).not.toBeInTheDocument()
  })
})

describe('formatReplies', () => {
  it('quotes each selection on one line above its reply', () => {
    expect(formatReplies([
      { id: '1', quote: 'First line\nsecond line', text: 'Explain this' },
      { id: '2', quote: 'Ship it', text: 'Agreed' },
    ])).toBe('Replying to what you wrote:\n\n> "First line second line"\nExplain this\n\n> "Ship it"\nAgreed')
  })
})
