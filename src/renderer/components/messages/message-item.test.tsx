// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MessageItem } from './message-item'
import { createUserMessage, createAssistantMessage, createToolCall } from '@renderer/test/factories'

// Mock SubAgentBlock and ToolCallItem to isolate MessageItem
vi.mock('./subagent-block', () => ({
  SubAgentBlock: ({ toolCall }: { toolCall: { name: string } }) => (
    <div data-testid="subagent-block">{toolCall.name}</div>
  ),
}))

vi.mock('./tool-call-item', () => ({
  ToolCallItem: ({ toolCall }: { toolCall: { name: string } }) => (
    <div data-testid={`tool-call-${toolCall.name}`}>{toolCall.name}</div>
  ),
  StreamingToolCallItem: ({ name }: { name: string }) => (
    <div data-testid="streaming-tool-call">{name}</div>
  ),
}))

// Mock MessageContextMenu to just render children
vi.mock('./message-context-menu', () => ({
  MessageContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

// Mock tooltip to render inline (avoids Radix portal issues in tests)
vi.mock('@renderer/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <span data-testid="tooltip-content">{children}</span>,
}))

describe('MessageItem', () => {
  describe('user messages', () => {
    it('renders with user data-testid', () => {
      const msg = createUserMessage({ content: { text: 'Hello world' } })
      render(<MessageItem message={msg} />)
      expect(screen.getByTestId('message-user')).toBeInTheDocument()
    })

    it('renders text content', () => {
      const msg = createUserMessage({ content: { text: 'Hello world' } })
      render(<MessageItem message={msg} />)
      expect(screen.getByText('Hello world')).toBeInTheDocument()
    })
  })

  describe('assistant messages', () => {
    it('renders with assistant data-testid', () => {
      const msg = createAssistantMessage({ content: { text: 'Hi there' } })
      render(<MessageItem message={msg} />)
      expect(screen.getByTestId('message-assistant')).toBeInTheDocument()
    })

    it('renders markdown content', () => {
      const msg = createAssistantMessage({ content: { text: '# Heading\n\nSome text' } })
      render(<MessageItem message={msg} />)
      expect(screen.getByText('Heading')).toBeInTheDocument()
      expect(screen.getByText('Some text')).toBeInTheDocument()
    })

    it('renders links with target="_blank"', () => {
      const msg = createAssistantMessage({ content: { text: '[Click here](https://example.com)' } })
      render(<MessageItem message={msg} />)
      const link = screen.getByText('Click here')
      expect(link).toHaveAttribute('target', '_blank')
      expect(link).toHaveAttribute('href', 'https://example.com')
    })

    it('renders code blocks', () => {
      const msg = createAssistantMessage({ content: { text: '```js\nconsole.log("hi")\n```' } })
      render(<MessageItem message={msg} />)
      expect(screen.getByText('console.log("hi")')).toBeInTheDocument()
    })

    it('returns null for empty assistant message (no text, no tools, not streaming)', () => {
      const msg = createAssistantMessage({
        content: { text: '' },
        toolCalls: [],
      })
      const { container } = render(<MessageItem message={msg} />)
      expect(container.innerHTML).toBe('')
    })

    it('renders when empty but streaming', () => {
      const msg = createAssistantMessage({
        content: { text: '' },
        toolCalls: [],
      })
      render(<MessageItem message={msg} isStreaming />)
      // Should render the streaming cursor
      expect(screen.getByTestId('message-assistant')).toBeInTheDocument()
    })

    it('renders when has tool calls but no text', () => {
      const msg = createAssistantMessage({
        content: { text: '' },
        toolCalls: [createToolCall({ name: 'Read' })],
      })
      render(<MessageItem message={msg} />)
      expect(screen.getByTestId('tool-call-Read')).toBeInTheDocument()
    })
  })

  describe('streaming cursor', () => {
    it('shows streaming cursor when isStreaming=true and has text', () => {
      const msg = createAssistantMessage({ content: { text: 'Streaming text...' } })
      const { container } = render(<MessageItem message={msg} isStreaming />)
      // Look for the pulsing cursor element
      const cursor = container.querySelector('.animate-pulse')
      expect(cursor).toBeTruthy()
    })

    it('shows streaming cursor when isStreaming=true and no text', () => {
      const msg = createAssistantMessage({ content: { text: '' } })
      const { container } = render(<MessageItem message={msg} isStreaming />)
      const cursor = container.querySelector('.animate-pulse')
      expect(cursor).toBeTruthy()
    })
  })

  describe('tool calls', () => {
    it('renders tool calls below assistant message', () => {
      const msg = createAssistantMessage({
        content: { text: 'Let me help' },
        toolCalls: [
          createToolCall({ name: 'Bash' }),
          createToolCall({ name: 'Read' }),
        ],
      })
      render(<MessageItem message={msg} />)
      expect(screen.getByTestId('tool-call-Bash')).toBeInTheDocument()
      expect(screen.getByTestId('tool-call-Read')).toBeInTheDocument()
    })

    it('renders SubAgentBlock for Task tool calls when sessionId provided', () => {
      const msg = createAssistantMessage({
        content: { text: '' },
        toolCalls: [createToolCall({ name: 'Task', result: 'done' })],
      })
      render(<MessageItem message={msg} sessionId="s1" agentSlug="agent1" />)
      expect(screen.getByTestId('subagent-block')).toBeInTheDocument()
    })
  })

  describe('slash commands', () => {
    it('detects slash command in user message', () => {
      const msg = createUserMessage({ content: { text: '/deploy production' } })
      render(<MessageItem message={msg} />)
      // Slash command renders with mono font
      expect(screen.getByText('/deploy')).toBeInTheDocument()
      expect(screen.getByText('production')).toBeInTheDocument()
    })

    it('renders slash command without arguments', () => {
      const msg = createUserMessage({ content: { text: '/status' } })
      render(<MessageItem message={msg} />)
      expect(screen.getByText('/status')).toBeInTheDocument()
    })
  })

  describe('sender attribution', () => {
    it('renders sender initials in avatar when sender is present', () => {
      const msg = createUserMessage({
        content: { text: 'Hello' },
        sender: { id: 'user-1', name: 'Alice Baker', email: 'alice@example.com' },
      })
      render(<MessageItem message={msg} />)
      expect(screen.getByText('AB')).toBeInTheDocument()
    })

    it('renders sender name in tooltip when sender is present', () => {
      const msg = createUserMessage({
        content: { text: 'Hello' },
        sender: { id: 'user-1', name: 'Alice Baker', email: 'alice@example.com' },
      })
      render(<MessageItem message={msg} />)
      expect(screen.getByTestId('tooltip-content')).toHaveTextContent('Alice Baker')
    })

    it('renders default user icon when sender is absent', () => {
      const msg = createUserMessage({ content: { text: 'Hello' } })
      render(<MessageItem message={msg} />)
      expect(screen.queryByTestId('tooltip-content')).not.toBeInTheDocument()
    })

    it('does not render sender on assistant messages', () => {
      const msg = createAssistantMessage({
        content: { text: 'Hi there' },
      })
      render(<MessageItem message={msg} />)
      expect(screen.queryByTestId('tooltip-content')).not.toBeInTheDocument()
    })
  })
})
