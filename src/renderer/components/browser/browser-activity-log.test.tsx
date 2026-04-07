// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ApiMessage } from '@shared/lib/types/api'

// --- Mocks ---

const mockMessages: ApiMessage[] = []
const mockSubagentMessages: Record<string, ApiMessage[]> = {}

vi.mock('@renderer/hooks/use-messages', () => ({
  useMessages: () => ({ data: mockMessages }),
}))

vi.mock('@renderer/hooks/use-message-stream', () => ({
  useMessageStream: () => ({
    streamingToolUse: null,
    activeSubagents: [],
  }),
}))

const mockApiFetch = vi.fn((url: string) => {
  // Extract subagent ID from URL: /api/agents/.../subagent/<id>/messages
  const match = url.match(/subagent\/([^/]+)\/messages/)
  const subId = match?.[1]
  const msgs = subId ? mockSubagentMessages[subId] ?? [] : []
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve(msgs),
  })
})

vi.mock('@renderer/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args as [string]),
}))

vi.mock('@renderer/components/messages/tool-renderers', () => ({
  getToolRenderer: () => undefined,
}))

vi.mock('@renderer/lib/parse-tool-result', () => ({
  parseToolResult: () => ({ text: null }),
}))

vi.mock('@renderer/components/ui/scroll-area', () => ({
  ScrollArea: ({ children, className }: any) => <div className={className}>{children}</div>,
}))

vi.mock('lucide-react', () => ({
  Loader2: (props: any) => <span data-testid="icon-loader" {...props} />,
  ChevronRight: (props: any) => <span {...props} />,
  ChevronDown: (props: any) => <span {...props} />,
}))

// jsdom doesn't implement scrollIntoView
Element.prototype.scrollIntoView = vi.fn()

import { BrowserActivityLog } from './browser-activity-log'

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
})

function Wrapper({ children }: { children: React.ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}

function makeBrowserToolMessage(id: string, toolCalls: Array<{ id: string; name: string }>): ApiMessage {
  return {
    id,
    type: 'assistant',
    content: { text: '' },
    toolCalls: toolCalls.map(tc => ({
      ...tc,
      input: {},
    })),
  } as unknown as ApiMessage
}

function makeSubagentMessage(id: string, subagentId: string): ApiMessage {
  return {
    id,
    type: 'assistant',
    content: { text: '' },
    toolCalls: [{
      id: `task-${id}`,
      name: 'Task',
      input: {},
      subagent: { agentId: subagentId, status: 'completed' },
    }],
  } as unknown as ApiMessage
}

describe('BrowserActivityLog', () => {
  beforeEach(() => {
    mockMessages.length = 0
    Object.keys(mockSubagentMessages).forEach(k => delete mockSubagentMessages[k])
    queryClient.clear()
  })

  it('shows empty state when no browser activity', () => {
    render(<BrowserActivityLog sessionId="s1" agentSlug="agent-1" />, { wrapper: Wrapper })
    expect(screen.getByText('No browser activity yet')).toBeInTheDocument()
  })

  it('shows browser tool calls from main messages', () => {
    mockMessages.push(
      makeBrowserToolMessage('msg-1', [
        { id: 'tc-1', name: 'mcp__browser__click' },
        { id: 'tc-2', name: 'mcp__browser__fill' },
      ])
    )

    render(<BrowserActivityLog sessionId="s1" agentSlug="agent-1" />, { wrapper: Wrapper })
    // Should render 2 tool call entries (click and fill)
    expect(screen.getAllByRole('button')).toHaveLength(2)
  })

  it('excludes non-browser tool calls', () => {
    mockMessages.push(
      makeBrowserToolMessage('msg-1', [
        { id: 'tc-1', name: 'mcp__browser__click' },
        { id: 'tc-2', name: 'some_other_tool' },
      ])
    )

    render(<BrowserActivityLog sessionId="s1" agentSlug="agent-1" />, { wrapper: Wrapper })
    expect(screen.getAllByRole('button')).toHaveLength(1)
  })

  it('does not show text from assistant messages (actions only)', () => {
    mockMessages.push({
      id: 'msg-1',
      type: 'assistant',
      content: { text: 'I will click the button now' },
      toolCalls: [{ id: 'tc-1', name: 'mcp__browser__click', input: {} }],
    } as unknown as ApiMessage)

    render(<BrowserActivityLog sessionId="s1" agentSlug="agent-1" />, { wrapper: Wrapper })
    expect(screen.queryByText('I will click the button now')).not.toBeInTheDocument()
  })

  it('deduplicates tool calls by ID', () => {
    // Same tool call ID appearing in main messages
    mockMessages.push(
      makeBrowserToolMessage('msg-1', [{ id: 'tc-1', name: 'mcp__browser__click' }]),
      makeBrowserToolMessage('msg-2', [{ id: 'tc-1', name: 'mcp__browser__click' }]),
    )

    render(<BrowserActivityLog sessionId="s1" agentSlug="agent-1" />, { wrapper: Wrapper })
    expect(screen.getAllByRole('button')).toHaveLength(1)
  })

  it('collects subagent IDs from Task/Agent tool calls', async () => {
    mockMessages.push(
      makeSubagentMessage('msg-1', 'sub-1'),
      makeSubagentMessage('msg-2', 'sub-2'),
    )

    render(<BrowserActivityLog sessionId="s1" agentSlug="agent-1" />, { wrapper: Wrapper })
    // Wait for queries to fire
    await vi.waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        expect.stringContaining('subagent/sub-1/messages')
      )
      expect(mockApiFetch).toHaveBeenCalledWith(
        expect.stringContaining('subagent/sub-2/messages')
      )
    })
  })
})
