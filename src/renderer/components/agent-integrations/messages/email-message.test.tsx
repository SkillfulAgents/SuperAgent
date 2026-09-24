// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { IntegrationMessageDisplay } from '@shared/lib/agent-integrations/message-display-schema'
import { createUserMessage } from '@renderer/test/factories'
import { IntegrationMessage } from './integration-message'

const display: IntegrationMessageDisplay = {
  version: 1, integration: { id: 'email', name: 'Release Assistant', provider: 'platform-email', family: 'email' },
  event: { type: 'message', label: 'Received email' }, source: { kind: 'thread', title: 'Launch checklist' },
  request: { author: { name: 'Ada Lovelace' }, text: 'Please review the attached plan.\n\nThank you!', sentAt: '2026-09-22T10:00:00.000Z' },
  email: { from: 'Ada Lovelace <ada@example.com>', to: ['assistant@company.ongamut.so'], cc: ['grace@example.com'], replyTo: ['team@example.com'], attachmentCount: 1, quotedText: 'On Tuesday, Assistant wrote:\n> Here is the draft.' },
}
function card(value = display) {
  const message = createUserMessage({ content: { text: 'Original model input with complete headers and history' }, integration: value })
  return render(<IntegrationMessage message={message} text={message.content.text!} renderMarkdown={text => <p>{text}</p>} />)
}
it('uses the registered email card with subject, sender, date and attachments', () => {
  card()
  expect(screen.getByRole('article', { name: 'Email message' })).toBeInTheDocument()
  expect(screen.getByTestId('email-subject')).toHaveTextContent('Launch checklist')
  expect(screen.getByTestId('integration-message-author')).toHaveTextContent('Ada Lovelace')
  expect(screen.getByTestId('integration-message-request')).toHaveTextContent('Please review the attached plan.')
  expect(screen.getByText('1 attachment')).toBeInTheDocument()
  expect(document.querySelector('time')).toHaveAttribute('datetime', '2026-09-22T10:00:00.000Z')
})
it('keeps recipients, quoted history and agent input collapsed independently', () => {
  card()
  const envelope = screen.getByTestId('email-envelope')
  const quote = screen.getByTestId('email-quoted-history')
  expect(envelope).not.toHaveAttribute('open')
  expect(quote).not.toHaveAttribute('open')
  fireEvent.click(envelope.querySelector('summary')!)
  expect(envelope).toHaveAttribute('open')
  expect(envelope).toHaveTextContent('grace@example.com')
  expect(envelope).toHaveTextContent('team@example.com')
  fireEvent.click(screen.getByText('Quoted history'))
  expect(quote).toHaveAttribute('open')
  expect(screen.queryByTestId('integration-message-agent-input')).not.toBeInTheDocument()
  fireEvent.click(screen.getByTestId('integration-message-agent-input-toggle'))
  expect(screen.getByTestId('integration-message-agent-input')).toHaveTextContent('Original model input with complete headers and history')
})
it('renders sender, subject and message as text without executing HTML or loading trackers', () => {
  const malicious = '<img src="https://tracker.example/pixel" onerror="alert(1)">'
  const { container } = card({ ...display, source: { kind: 'thread', title: malicious }, request: { author: { name: malicious }, text: malicious } })
  expect(container.querySelector('img, iframe, script')).toBeNull()
  expect(screen.getByTestId('integration-message-request').textContent).toBe(malicious)
})
it('supports attachment-only messages and older metadata without envelope fields', () => {
  const { unmount } = card({ ...display, request: { text: '' }, email: { ...display.email!, quotedText: undefined } })
  expect(screen.getByText('See attached files.')).toBeInTheDocument()
  unmount()
  card({ ...display, email: undefined, source: { kind: 'thread' } })
  expect(screen.getByTestId('email-subject')).toHaveTextContent('(No subject)')
  expect(screen.queryByTestId('email-envelope')).not.toBeInTheDocument()
})
