// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { MessageItem } from './message-item'
import { parsePlatformErrorResponse } from '@shared/lib/llm-provider/platform-error-presentation'
import { createUserMessage, createAssistantMessage, createToolCall } from '@renderer/test/factories'

// Mock SubAgentBlock and ToolCallItem to isolate MessageItem
vi.mock('./subagent-block', () => ({
  SubAgentBlock: ({
    toolCall,
    activeSubagent,
    isCompleted,
  }: {
    toolCall: { name: string }
    activeSubagent?: { parentToolId: string } | null
    isCompleted?: boolean
  }) => (
    <div
      data-testid="subagent-block"
      data-active-parent={activeSubagent?.parentToolId ?? ''}
      data-completed={String(!!isCompleted)}
    >
      {toolCall.name}
    </div>
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

const platformAuth = {
  connected: false as boolean,
  platformBaseUrl: 'https://platform.example.com' as string | null,
  orgId: 'org_123' as string | null,
}

vi.mock('@renderer/hooks/use-platform-auth', () => ({
  usePlatformAuthStatus: () => ({ data: platformAuth }),
}))

describe('MessageItem', () => {
  beforeEach(() => {
    platformAuth.connected = false
  })

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

    it('renders a container screenshot through its verified tool-result alias', () => {
      const fileUrl = 'file:///home/claude/.agent-browser/tmp/screenshots/shot.png'
      const mediaUrl = '/api/agents/a/sessions/s/media/ref_123'
      const msg = createAssistantMessage({
        content: { text: `![Captured page](${fileUrl})` },
      })

      const { container } = render(
        <MessageItem
          message={msg}
          embeddedImageAliases={new Map([[fileUrl, mediaUrl]])}
        />
      )

      expect(container.querySelector('img')).toHaveAttribute('src', mediaUrl)
      expect(container.querySelector('img')).toHaveAttribute('alt', 'Captured page')
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

  describe('streaming word reveal', () => {
    it('adds a reveal hook to prose words in the active Markdown tail', () => {
      const msg = createAssistantMessage({ content: { text: 'Hello **bright** world' } })
      const { container } = render(<MessageItem message={msg} isStreaming />)
      const words = Array.from(container.querySelectorAll<HTMLElement>('.streaming-word-reveal'))

      expect(words.map((word) => word.textContent)).toEqual(['Hello', 'bright', 'world'])
      expect(words.map((word) => word.style.animationDelay)).toEqual(['0ms', '36ms', '72ms'])
    })

    it('keeps settled paragraphs and inline code crisp', () => {
      const msg = createAssistantMessage({
        content: { text: 'Already settled.\n\nRun `npm test` next' },
      })
      const { container } = render(<MessageItem message={msg} isStreaming />)
      const paragraphs = container.querySelectorAll('p')

      expect(paragraphs[0].querySelector('.streaming-word-reveal')).toBeNull()
      expect(paragraphs[1].querySelectorAll('.streaming-word-reveal')).toHaveLength(2)
      expect(paragraphs[1].querySelector('code .streaming-word-reveal')).toBeNull()
    })

    it('does not replay the reveal on words that were already mounted', () => {
      const first = createAssistantMessage({ content: { text: 'Hello' } })
      const { container, rerender } = render(<MessageItem message={first} isStreaming />)
      const hello = container.querySelector('.streaming-word-reveal')

      const next = createAssistantMessage({ ...first, content: { text: 'Hello world' } })
      rerender(<MessageItem message={next} isStreaming />)

      const words = container.querySelectorAll('.streaming-word-reveal')
      expect(words).toHaveLength(2)
      expect(words[0]).toBe(hello)
      expect(words[1]).toHaveTextContent('world')
    })

    it('starts each appended paragraph chunk as a fresh compact word wave', () => {
      const first = createAssistantMessage({ content: { text: 'Already visible' } })
      const { container, rerender } = render(<MessageItem message={first} isStreaming />)
      const existing = Array.from(
        container.querySelectorAll<HTMLElement>('.streaming-word-reveal')
      ).map((word) => word.style.animationDelay)

      const next = createAssistantMessage({
        ...first,
        content: { text: 'Already visible and now four more words' },
      })
      rerender(<MessageItem message={next} isStreaming />)

      const delays = Array.from(
        container.querySelectorAll<HTMLElement>('.streaming-word-reveal')
      ).map((word) => word.style.animationDelay)
      expect(delays.slice(0, 2)).toEqual(existing)
      expect(delays.slice(2)).toEqual(['0ms', '36ms', '72ms', '108ms', '144ms'])
    })

    it('renders persisted responses without reveal wrappers', () => {
      const msg = createAssistantMessage({ content: { text: 'All done' } })
      const { container } = render(<MessageItem message={msg} />)

      expect(container.querySelector('.streaming-word-reveal')).toBeNull()
    })
  })

  describe('streaming markdown splitting', () => {
    it('renders every block of a multi-block streaming message', () => {
      const text = '# Heading\n\nSome text\n\n```js\nconsole.log("hi")\n```\n\nMore text'
      const msg = createAssistantMessage({ content: { text } })
      render(<MessageItem message={msg} isStreaming />)
      expect(screen.getByText('Heading')).toBeInTheDocument()
      expect(screen.getByText('Some text')).toBeInTheDocument()
      expect(screen.getByText('console.log("hi")')).toBeInTheDocument()
      expect(screen.getByTestId('message-assistant')).toHaveTextContent('More text')
    })

    it('keeps an in-progress code fence (with an internal blank line) intact while streaming', () => {
      // Unterminated fence whose body contains a blank line. A naive \n\n split
      // would freeze a broken open fence, leaving `const y = 2` outside the code
      // block. The fence-aware split keeps the whole fence in the tail.
      const text = 'Intro paragraph\n\n```js\nconst x = 1\n\nconst y = 2'
      const msg = createAssistantMessage({ content: { text } })
      const { container } = render(<MessageItem message={msg} isStreaming />)
      expect(screen.getByText('Intro paragraph')).toBeInTheDocument()
      const pres = container.querySelectorAll('pre')
      expect(pres.length).toBe(1)
      // Both lines live inside the SAME code block — the discriminating check.
      expect(pres[0].textContent).toContain('const x = 1')
      expect(pres[0].textContent).toContain('const y = 2')
    })

    it('renders the same text (whitespace-insensitive) while streaming as a single-document parse', () => {
      const text =
        '# Title\n\nFirst paragraph with **bold**.\n\n- a\n- b\n\n```ts\nconst n = 1\n```\n\nClosing line.'
      const msg = createAssistantMessage({ content: { text } })
      // Per-block rendering adds invisible whitespace text nodes between block
      // elements (block-level CSS margins handle real spacing), so we compare
      // visible characters ignoring whitespace: nothing dropped, added, or reordered.
      const norm = (s: string | null) => (s ?? '').replace(/\s+/g, '')

      const streamed = render(<MessageItem message={msg} isStreaming />)
      const streamedText = norm(streamed.container.textContent)
      streamed.unmount()

      const whole = render(<MessageItem message={msg} />)
      expect(norm(whole.container.textContent)).toBe(streamedText)
    })

    // The split's accepted trade-off: cross-block markdown constructs (reference-
    // style links, loose lists) render differently MID-STREAM, then self-heal the
    // instant the message persists and re-renders as one document. These tests pin
    // BOTH the transient artifact AND the self-heal, since the self-heal is what
    // makes the artifact acceptable.
    it('reference-style link is literal while streaming, resolves once persisted', () => {
      const text = 'See [the docs][1] for details.\n\n[1]: https://example.com'
      const msg = createAssistantMessage({ content: { text } })

      // Streaming: usage and its later definition land in separate blocks, so the
      // link cannot resolve — it shows as literal bracket text, no anchor.
      const streamed = render(<MessageItem message={msg} isStreaming />)
      expect(streamed.container.querySelectorAll('a')).toHaveLength(0)
      expect(streamed.container.textContent).toContain('[the docs][1]')
      streamed.unmount()

      // Persisted (whole-document parse): the reference resolves to a real link.
      const whole = render(<MessageItem message={msg} />)
      const link = whole.container.querySelector('a')
      expect(link).not.toBeNull()
      expect(link).toHaveAttribute('href', 'https://example.com')
      expect(whole.container.textContent).not.toContain('[the docs][1]')
    })

    it('loose list splits into separate lists while streaming, collapses to one when persisted', () => {
      const text = '1. a\n\n2. b\n\n3. c'
      const msg = createAssistantMessage({ content: { text } })

      // Streaming: blank-separated items settle into separate blocks -> separate <ol>.
      const streamed = render(<MessageItem message={msg} isStreaming />)
      expect(streamed.container.querySelectorAll('ol').length).toBeGreaterThan(1)
      streamed.unmount()

      // Persisted: one continuous list.
      const whole = render(<MessageItem message={msg} />)
      expect(whole.container.querySelectorAll('ol')).toHaveLength(1)
      expect(whole.container.querySelectorAll('li')).toHaveLength(3)
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

    it('passes the running resumed lifecycle to the original subagent block', () => {
      const msg = createAssistantMessage({
        content: { text: '' },
        toolCalls: [createToolCall({
          id: 'agent-tool',
          name: 'Agent',
          result: 'FIRST_DONE',
          subagent: { agentId: 'agent-1', status: 'completed' },
        })],
      })
      const baseSubagent = {
        agentId: 'agent-1',
        streamingMessage: null,
        streamingToolUse: null,
        progressSummary: null,
        subagentType: 'general-purpose',
        description: 'Resume UI probe',
        usage: null,
        lastToolName: null,
      }

      render(
        <MessageItem
          message={msg}
          sessionId="s1"
          agentSlug="agent1"
          isSessionActive
          activeSubagents={[
            { ...baseSubagent, parentToolId: 'agent-tool' },
            { ...baseSubagent, parentToolId: 'send-tool', progressSummary: 'Running resumed task' },
          ]}
          completedSubagents={new Set(['agent-tool'])}
        />
      )

      expect(screen.getByTestId('subagent-block')).toHaveAttribute('data-active-parent', 'send-tool')
      expect(screen.getByTestId('subagent-block')).toHaveAttribute('data-completed', 'false')
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
    it('renders sender name when sender is present', () => {
      const msg = createUserMessage({
        content: { text: 'Hello' },
        sender: { id: 'user-1', name: 'Alice Baker', email: 'alice@example.com' },
      })
      render(<MessageItem message={msg} />)
      expect(screen.getByText('Alice Baker')).toBeInTheDocument()
    })

    it('does not render sender name when sender is absent', () => {
      const msg = createUserMessage({ content: { text: 'Hello' } })
      render(<MessageItem message={msg} />)
      expect(screen.queryByText('Alice Baker')).not.toBeInTheDocument()
    })

    it('does not render sender on assistant messages', () => {
      const msg = createAssistantMessage({
        content: { text: 'Hi there' },
      })
      render(<MessageItem message={msg} />)
      expect(screen.queryByTestId('tooltip-content')).not.toBeInTheDocument()
    })
  })

  describe('LLM provider error messages', () => {
    it('renders provider error card when apiError is a provider error code', () => {
      const msg = createAssistantMessage({
        content: { text: 'Invalid API key' },
        apiError: 'authentication_failed',
      })
      render(<MessageItem message={msg} />)
      expect(screen.getByTestId('provider-error-card')).toHaveTextContent('LLM Provider Error: Invalid API key')
      act(() => { screen.getByTestId('provider-error-card').click() })
      expect(screen.getByText(/external LLM provider API/)).toBeInTheDocument()
    })

    it('renders normal markdown when apiError is absent', () => {
      const msg = createAssistantMessage({
        content: { text: 'Hello world' },
      })
      render(<MessageItem message={msg} />)
      expect(screen.queryByText('LLM Provider Error')).not.toBeInTheDocument()
      expect(screen.getByText('Hello world')).toBeInTheDocument()
    })

    it('renders normal markdown when apiError is not a provider error code', () => {
      const msg = createAssistantMessage({
        content: { text: 'Output too long' },
        apiError: 'max_output_tokens',
      })
      render(<MessageItem message={msg} />)
      expect(screen.queryByText('LLM Provider Error')).not.toBeInTheDocument()
      expect(screen.getByText('Output too long')).toBeInTheDocument()
    })

    it('renders an orange spend-limit card from a server-attached presentation', () => {
      platformAuth.connected = true
      const spendCap =
        'API Error: Request rejected (429) · A spend cap for this workspace was reached. It resets within 30 days. Ask a workspace admin to raise it.'
      const msg = createAssistantMessage({
        content: { text: spendCap },
        apiError: 'rate_limit',
        errorPresentation: parsePlatformErrorResponse(429, spendCap),
      })
      render(<MessageItem message={msg} />)
      const card = screen.getByTestId('provider-error-card')
      expect(card).toHaveTextContent('Spend Limit Reached')
      expect(card).toHaveTextContent('A spend cap for this workspace was reached. It resets within 30 days.')
      expect(card).not.toHaveTextContent('LLM Provider Error')
      expect(card).toHaveAttribute('data-severity', 'warning')
      expect(card).toHaveClass('bg-orange-50', 'dark:bg-orange-950')
      expect(screen.getByRole('link', { name: /raise spend limit/i })).toBeInTheDocument()
    })

    it('falls back to the generic provider banner when no presentation is attached', () => {
      const msg = createAssistantMessage({
        content: {
          text: 'API Error: Request rejected (429) · A spend cap for this workspace was reached. It resets within 30 days.',
        },
        apiError: 'rate_limit',
      })
      render(<MessageItem message={msg} />)
      expect(screen.getByTestId('provider-error-card')).toHaveTextContent('LLM Provider Error')
      expect(screen.queryByRole('link', { name: /raise spend limit/i })).not.toBeInTheDocument()
    })
  })
})
