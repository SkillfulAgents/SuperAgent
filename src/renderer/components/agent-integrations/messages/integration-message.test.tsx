// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import type { IntegrationMessageDisplay } from '@shared/lib/agent-integrations/message-display-schema'
import { createUserMessage } from '@renderer/test/factories'
import { IntegrationMessage } from './integration-message'

const MODEL_TEXT = 'Task event: invocation\nRequest: Can you fix the build?\n\nInvocation context (external content):\n{"notificationId":"n-1"}'

function card(display: IntegrationMessageDisplay) {
  const message = createUserMessage({ content: { text: MODEL_TEXT }, integration: display, createdAt: new Date('2026-09-22T10:00:00Z') })
  return render(<IntegrationMessage text={MODEL_TEXT} message={message} renderMarkdown={(text) => <p>{text}</p>} />)
}

const slack: IntegrationMessageDisplay = {
  version: 1,
  integration: { id: 'i-slack', name: 'Support bot', provider: 'slack', family: 'chat' },
  event: { type: 'message', label: 'Channel message' },
  request: {
    text: 'Can you check the deploy?', sentAt: '2026-09-22T10:00:00.000Z', url: 'https://acme.slack.com/archives/C1/p1',
    author: { name: 'Ada Lovelace', avatarUrl: 'https://avatars.slack-edge.com/ada.png' },
  },
  source: { kind: 'channel', title: '#ops', workspace: 'Acme', url: 'https://acme.slack.com/archives/C1' },
}

const linear: IntegrationMessageDisplay = {
  version: 1,
  integration: { id: 'i-linear', name: 'Release bot', provider: 'linear', family: 'task-manager' },
  event: { type: 'comment_mention', label: 'Mentioned in a comment' },
  request: { text: 'Can you fix the build?', author: { name: 'Grace Hopper' }, url: 'https://linear.app/acme/issue/SUP-879' },
  source: { kind: 'task', identifier: 'SUP-879', title: 'Shared renderer', url: 'https://linear.app/acme/issue/SUP-879', status: { name: 'In Progress', category: 'started' } },
  task: { priority: { level: 2, label: 'High' }, labels: ['Frontend'], assignee: 'Iddo', description: 'Render integration messages nicely.' },
}

describe('IntegrationMessage', () => {
  it('draws a Slack message with its sender, channel and link, and keeps the agent input collapsed', () => {
    card(slack)
    const root = screen.getByTestId('integration-message')
    expect(root).toHaveAttribute('data-provider', 'slack')
    expect(within(root).getByTestId('integration-message-author')).toHaveTextContent('Ada Lovelace')
    expect(within(root).getByTestId('integration-message-request')).toHaveTextContent('Can you check the deploy?')
    expect(within(root).getByTestId('slack-message-channel')).toHaveTextContent('ops')
    expect(within(root).getByTestId('integration-message-event')).toHaveTextContent('Slack · Channel message')
    expect(within(root).getByTestId('integration-message-link')).toHaveAttribute('href', 'https://acme.slack.com/archives/C1/p1')
    expect(root.querySelector('img[src="https://avatars.slack-edge.com/ada.png"]')).toHaveAttribute('referrerpolicy', 'no-referrer')

    expect(screen.queryByText(/notificationId/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('integration-message-agent-input-toggle'))
    expect(screen.getByTestId('integration-message-agent-input').textContent).toBe(MODEL_TEXT)
  })

  it('previews a Linear ticket with the comment that invoked the agent', () => {
    card(linear)
    const preview = screen.getByTestId('linear-ticket-preview')
    expect(preview).toHaveTextContent('SUP-879')
    expect(preview).toHaveTextContent('Shared renderer')
    expect(screen.getByTestId('linear-ticket-status')).toHaveTextContent('In Progress')
    expect(preview).toHaveTextContent('High')
    expect(preview).toHaveTextContent('Frontend')
    expect(within(screen.getByTestId('linear-comment')).getByTestId('integration-message-author')).toHaveTextContent('Grace Hopper')
    expect(screen.getByTestId('integration-message-link')).toHaveTextContent('Open in Linear')
  })

  it('shows an assignment as the ticket alone', () => {
    card({ ...linear, event: { type: 'assigned', label: 'Assigned an issue' }, request: undefined })
    expect(screen.getByTestId('linear-ticket-preview')).toBeInTheDocument()
    expect(screen.queryByTestId('linear-comment')).not.toBeInTheDocument()
    expect(screen.getByTestId('integration-message-event')).toHaveTextContent('Assigned an issue')
  })

  it.each([
    ['imessage', 'iMessage · Direct message'],
    ['telegram', 'Telegram · Direct message'],
  ])('draws a %s bubble with the sender', (provider, event) => {
    card({ ...slack, integration: { ...slack.integration, provider, name: provider === 'imessage' ? 'iMessage' : 'Telegram' }, event: { type: 'message', label: 'Direct message' }, source: { kind: 'direct' } })
    expect(screen.getByTestId('integration-message')).toHaveAttribute('data-provider', provider)
    expect(screen.getByTestId('integration-message-event')).toHaveTextContent(event)
    expect(screen.getByTestId('integration-message-author')).toHaveTextContent('Ada Lovelace')
    expect(screen.getByTestId('integration-message-request')).toHaveTextContent('Can you check the deploy?')
  })

  it('falls back to a plain card for a provider without a preview, keeping the stored name', () => {
    card({ ...slack, integration: { id: 'gone', name: 'Old helpdesk', provider: 'zendesk', family: 'ticketing' }, event: { type: 'ticket', label: 'New ticket' } })
    const root = screen.getByTestId('integration-message')
    expect(root).toHaveAttribute('data-provider', 'zendesk')
    expect(root).toHaveTextContent('Zendesk · New ticket · via Old helpdesk')
    expect(root).toHaveTextContent('Can you check the deploy?')
    expect(root).toHaveTextContent('#ops')
  })

  it('renders nothing without card data', () => {
    const { container } = render(<IntegrationMessage text="x" message={createUserMessage()} renderMarkdown={(text) => text} />)
    expect(container).toBeEmptyDOMElement()
  })
})
