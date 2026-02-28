// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ToolCallItem, StreamingToolCallItem } from './tool-call-item'
import { formatToolName } from './tool-call-item'
import { createToolCall } from '@renderer/test/factories'

// Mock getToolRenderer to return null (generic display)
vi.mock('./tool-renderers', () => ({
  getToolRenderer: () => null,
}))

// Mock parseToolResult
vi.mock('@renderer/lib/parse-tool-result', () => ({
  parseToolResult: (result: unknown) => ({
    text: result != null ? String(result) : null,
    images: [],
  }),
}))

// Mock useElapsedTimer for deterministic values
vi.mock('@renderer/hooks/use-elapsed-timer', () => ({
  useElapsedTimer: (startTime: unknown) => (startTime ? '5s' : null),
  formatElapsed: (ms: number) => `${Math.floor(ms / 1000)}s`,
}))

describe('formatToolName', () => {
  it('formats standard mcp tool names', () => {
    expect(formatToolName('mcp__granola__list_meetings')).toBe('Granola MCP: List Meetings')
  })

  it('handles hyphenated server names', () => {
    expect(formatToolName('mcp__user-input__request_secret')).toBe('User Input MCP: Request Secret')
  })

  it('handles server names with underscores', () => {
    expect(formatToolName('mcp__google_sheets__read_range')).toBe('Google Sheets MCP: Read Range')
  })

  it('handles camelCase tool names', () => {
    expect(formatToolName('mcp__ide__getDiagnostics')).toBe('Ide MCP: Get Diagnostics')
    expect(formatToolName('mcp__ide__executeCode')).toBe('Ide MCP: Execute Code')
  })

  it('returns non-mcp names unchanged', () => {
    expect(formatToolName('Bash')).toBe('Bash')
    expect(formatToolName('WebSearch')).toBe('WebSearch')
    expect(formatToolName('Read')).toBe('Read')
  })

  it('returns names without double-underscore structure unchanged', () => {
    expect(formatToolName('mcp_single_underscores')).toBe('mcp_single_underscores')
    expect(formatToolName('some_random_name')).toBe('some_random_name')
  })

  it('handles tool names with double underscores in the tool part', () => {
    // server matched lazily, rest goes to tool; consecutive underscores collapse to one space
    expect(formatToolName('mcp__server__do__something')).toBe('Server MCP: Do Something')
  })
})

describe('ToolCallItem', () => {
  describe('status display', () => {
    it('renders success status for tool with result', () => {
      const tc = createToolCall({ result: 'output here' })
      render(<ToolCallItem toolCall={tc} />)
      expect(screen.getByTestId('tool-call-Bash')).toBeInTheDocument()
    })

    it('renders error status for tool with error', () => {
      const tc = createToolCall({ result: 'error details', isError: true })
      render(<ToolCallItem toolCall={tc} />)
      expect(screen.getByTestId('tool-call-Bash')).toBeInTheDocument()
    })

    it('renders running status for tool with no result when session is active', () => {
      const tc = createToolCall({ result: undefined })
      render(
        <ToolCallItem
          toolCall={tc}
          messageCreatedAt={new Date('2025-01-01T00:00:00Z')}
          isSessionActive
        />
      )
      // Should show elapsed timer for running state
      expect(screen.getByText('5s')).toBeInTheDocument()
    })

    it('renders cancelled status for tool with no result when session is not active', () => {
      const tc = createToolCall({ result: undefined })
      render(<ToolCallItem toolCall={tc} isSessionActive={false} />)
      // No elapsed timer for cancelled
      expect(screen.queryByText('5s')).not.toBeInTheDocument()
    })
  })

  describe('tool name', () => {
    it('renders tool name', () => {
      const tc = createToolCall({ name: 'WebSearch' })
      render(<ToolCallItem toolCall={tc} />)
      expect(screen.getByText('WebSearch')).toBeInTheDocument()
    })
  })

  describe('expand/collapse', () => {
    it('is collapsed by default', () => {
      const tc = createToolCall({ input: { command: 'ls -la' }, result: 'file list' })
      render(<ToolCallItem toolCall={tc} />)
      // Input and Output labels should not be visible
      expect(screen.queryByText('Input')).not.toBeInTheDocument()
      expect(screen.queryByText('Output')).not.toBeInTheDocument()
    })

    it('expands on click to show input and output', async () => {
      const user = userEvent.setup()
      const tc = createToolCall({ input: { command: 'ls -la' }, result: 'file list' })
      render(<ToolCallItem toolCall={tc} />)

      // Click to expand
      await user.click(screen.getByText('Bash'))
      expect(screen.getByText('Input')).toBeInTheDocument()
      expect(screen.getByText('Output')).toBeInTheDocument()
    })

    it('shows Error label instead of Output when tool has error', async () => {
      const user = userEvent.setup()
      const tc = createToolCall({ result: 'command not found', isError: true })
      render(<ToolCallItem toolCall={tc} />)

      await user.click(screen.getByText('Bash'))
      expect(screen.getByText('Error')).toBeInTheDocument()
      expect(screen.queryByText('Output')).not.toBeInTheDocument()
    })

    it('collapses on second click', async () => {
      const user = userEvent.setup()
      const tc = createToolCall({ result: 'output' })
      render(<ToolCallItem toolCall={tc} />)

      await user.click(screen.getByText('Bash'))
      expect(screen.getByText('Input')).toBeInTheDocument()

      await user.click(screen.getByText('Bash'))
      expect(screen.queryByText('Input')).not.toBeInTheDocument()
    })
  })

  describe('input display', () => {
    it('shows JSON-formatted input in expanded view', async () => {
      const user = userEvent.setup()
      const tc = createToolCall({ input: { command: 'echo hello' }, result: 'hello' })
      render(<ToolCallItem toolCall={tc} />)

      await user.click(screen.getByText('Bash'))
      // JSON.stringify with indentation
      expect(screen.getByText(/echo hello/)).toBeInTheDocument()
    })
  })
})

describe('StreamingToolCallItem', () => {
  it('renders spinner, name and elapsed timer', () => {
    const { container } = render(
      <StreamingToolCallItem name="Read" partialInput='{"file_path": "/tmp/test"}' />
    )
    expect(screen.getByText('Read')).toBeInTheDocument()
    expect(screen.getByText('5s')).toBeInTheDocument()
    // Should have the spinner
    expect(container.querySelector('.animate-spin')).toBeTruthy()
  })

  it('renders partial input', () => {
    render(
      <StreamingToolCallItem name="Write" partialInput='{"file_path": "/tmp' />
    )
    expect(screen.getByText('Input')).toBeInTheDocument()
  })

  it('shows waiting message when partialInput is empty', () => {
    render(<StreamingToolCallItem name="Bash" partialInput="" />)
    expect(screen.getByText('Waiting for input...')).toBeInTheDocument()
  })
})
