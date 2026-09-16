// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { buildConnectionReplacementMessage } from '@shared/lib/utils/connection-replacement-message'
import { createUserMessage } from '@renderer/test/factories'
import { ConnectionReplacementNotice } from './connection-replacement'

it.each([
  ['connected-accounts', 'Slack', 'account'],
  ['remote-mcps', 'Amplitude', 'MCP'],
] as const)('renders a %s replacement as a system notice with optional IDs', (kind, name, reference) => {
  const text = buildConnectionReplacementMessage({ kind, name, previousId: 'old-id', replacementId: 'new-id' })
  const renderMarkdown = vi.fn()
  render(<ConnectionReplacementNotice text={text} message={createUserMessage()} renderMarkdown={renderMarkdown} />)
  const notice = screen.getByTestId('connection-replacement-notice')
  expect(notice).toHaveTextContent(`${name} connection replaced`)
  expect(notice).toHaveTextContent('Session interrupted. Agent notified')
  expect(notice.querySelector('details')).not.toHaveAttribute('open')
  expect(notice).toHaveTextContent(`Previous ${reference} ID`)
  expect(notice).toHaveTextContent(`New ${reference} ID`)
  expect(notice).toHaveTextContent('new-id')
  expect(notice).not.toHaveTextContent('[SYSTEM]')
  expect(renderMarkdown).not.toHaveBeenCalled()
})

describe('unrecognized input', () => {
  it('does not render a partial or unrelated notice', () => {
    render(<ConnectionReplacementNotice text="[SYSTEM] Other message" message={createUserMessage()} renderMarkdown={vi.fn()} />)
    expect(screen.queryByTestId('connection-replacement-notice')).not.toBeInTheDocument()
  })
})
