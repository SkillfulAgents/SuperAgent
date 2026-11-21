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

  it('renders a Teams thread with its author, team, channel and link to the original message', () => {
    const url = 'https://teams.microsoft.com/l/message/19%3Aops/123'
    card({
      ...slack,
      integration: { ...slack.integration, provider: 'teams' },
      event: { type: 'message', label: 'Thread reply' },
      request: { ...slack.request!, url, author: { name: 'Ada Lovelace' } },
      source: { kind: 'thread', workspace: 'Support', title: 'Releases' },
    })
    const root = screen.getByTestId('integration-message')
    expect(root).toHaveAttribute('data-provider', 'teams')
    expect(root).toHaveTextContent('Microsoft Teams · Thread reply')
    expect(root).toHaveTextContent('Support / Releases')
    expect(within(root).getByTestId('integration-message-author')).toHaveTextContent('Ada Lovelace')
    expect(within(root).getByTestId('integration-message-request')).toHaveTextContent('Can you check the deploy?')
    expect(within(root).getByTestId('integration-message-link')).toHaveAttribute('href', url)
    expect(screen.queryByText(/notificationId/)).not.toBeInTheDocument()
  })

  it('opens the available bot chat when an older DM card stored a connector-only link', () => {
    const botChat = 'https://teams.microsoft.com/l/chat/0/0?users=28%3A46e47d11-43c3-4154-a728-5d3526930a00&tenantId=43d49dd5-750f-48a5-9a8e-5cecc581d6ef'
    card({ ...slack, integration: { ...slack.integration, provider: 'teams' },
      request: { text: 'Hi', url: 'https://teams.microsoft.com/l/message/a%3AbotConnector/123' }, source: { kind: 'direct', url: botChat } })
    expect(screen.getByRole('link', { name: 'Open chat in Microsoft Teams' })).toHaveAttribute('href', botChat)
  })

  it('hides a historical unreachable Teams link without a usable conversation fallback', () => {
    card({ ...slack, integration: { ...slack.integration, provider: 'teams' },
      request: { text: 'Hi', url: 'https://teams.microsoft.com/l/message/a%3AbotConnector/123' }, source: { kind: 'direct' } })
    expect(screen.queryByTestId('integration-message-link')).not.toBeInTheDocument()
    expect(screen.getByTestId('integration-message-request')).toHaveTextContent('Hi')
  })

  it('adds the Teams chat context to a historical group message permalink', () => {
    card({ ...slack, integration: { ...slack.integration, provider: 'teams' },
      request: { text: 'Hi', url: 'https://teams.microsoft.com/l/message/19%3Agroup%40thread.v2/123' }, source: { kind: 'group' } })
    const link = new URL(screen.getByTestId('integration-message-link').getAttribute('href')!)
    expect(link.searchParams.get('context')).toBe('{"contextType":"chat"}')
    expect(decodeURIComponent(link.pathname)).toBe('/l/message/19:group@thread.v2/123')
  })

  it('represents a Teams attachment without a message body', () => {
    card({ ...slack, integration: { ...slack.integration, provider: 'teams' }, source: { kind: 'direct' }, request: { text: '', author: { name: 'Amal' } } })
    expect(screen.getByTestId('integration-message-request')).toHaveTextContent('Shared attachment')
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
