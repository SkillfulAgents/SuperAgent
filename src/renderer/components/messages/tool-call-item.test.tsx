// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ToolCallItem, StreamingToolCallItem } from './tool-call-item'
import { formatToolName } from './tool-call-item'
import { createToolCall } from '@renderer/test/factories'

// Mock getToolRenderer to return null (generic display)
vi.mock('./tool-renderers', () => ({
  getToolRenderer: () => null,
}))

// Mock parseToolResult
const { mockParseToolResult } = vi.hoisted(() => ({ mockParseToolResult: vi.fn() }))
mockParseToolResult.mockImplementation((result: unknown) => ({
  text: result != null ? String(result) : null,
  images: [],
}))
vi.mock('@renderer/lib/parse-tool-result', () => ({
  // Older cases in this file describe results without `documents`; fill it the way the real parser always does.
  parseToolResult: (result: unknown) => ({ documents: [], ...mockParseToolResult(result) }),
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
      await user.click(screen.getByTestId('tool-call-toggle-Bash'))
      expect(screen.getByText('Input')).toBeInTheDocument()
      expect(screen.getByText('Output')).toBeInTheDocument()
    })

    it('shows Error label instead of Output when tool has error', async () => {
      const user = userEvent.setup()
      const tc = createToolCall({ result: 'command not found', isError: true })
      render(<ToolCallItem toolCall={tc} />)

      await user.click(screen.getByTestId('tool-call-toggle-Bash'))
      expect(screen.getByText('Error')).toBeInTheDocument()
      expect(screen.queryByText('Output')).not.toBeInTheDocument()
    })

    it('collapses on second click', async () => {
      const user = userEvent.setup()
      const tc = createToolCall({ result: 'output' })
      render(<ToolCallItem toolCall={tc} />)

      await user.click(screen.getByTestId('tool-call-toggle-Bash'))
      expect(screen.getByText('Input')).toBeInTheDocument()

      await user.click(screen.getByTestId('tool-call-toggle-Bash'))
      expect(screen.queryByText('Input')).not.toBeInTheDocument()
    })
  })

  describe('input display', () => {
    it('shows JSON-formatted input in expanded view', async () => {
      const user = userEvent.setup()
      const tc = createToolCall({ input: { command: 'echo hello' }, result: 'hello' })
      render(<ToolCallItem toolCall={tc} />)

      await user.click(screen.getByTestId('tool-call-toggle-Bash'))
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

describe('ToolCallItem result images', () => {
  const refImage = {
    src: '/api/agents/a/sessions/s/media/ref-1',
    bytes: 40960,
    isRef: true,
  }

  // These override the shared parse mock; put it back so order stays irrelevant.
  afterEach(() => {
    mockParseToolResult.mockImplementation((result: unknown) => ({
      text: result != null ? String(result) : null,
      images: [],
    }))
  })

  it('does not mount a referenced image until the call is expanded', async () => {
    mockParseToolResult.mockReturnValue({ text: 'done', images: [refImage] })
    const { container } = render(
      <ToolCallItem toolCall={createToolCall({ name: 'Read', result: 'done' })} />
    )
    // Collapsed: nothing to fetch.
    expect(container.querySelector('img')).toBeNull()

    await userEvent.click(screen.getByRole('button'))
    const img = container.querySelector('img')
    expect(img).toHaveAttribute('src', refImage.src)
    expect(img).toHaveAttribute('loading', 'lazy')
  })

  it('offers a retry rather than declaring the image permanently gone', async () => {
    mockParseToolResult.mockReturnValue({ text: 'done', images: [refImage] })
    const { container } = render(
      <ToolCallItem toolCall={createToolCall({ name: 'Read', result: 'done' })} />
    )
    await userEvent.click(screen.getByRole('button'))

    const img = container.querySelector('img')!
    fireEvent.error(img)

    // An <img> error carries no reason, so the copy must not claim one.
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByText(/couldn't load image/i)).toBeInTheDocument()
    expect(screen.queryByText(/no longer available/i)).not.toBeInTheDocument()

    // Retrying re-requests instead of re-showing the failed load.
    await userEvent.click(screen.getByRole('button', { name: /retry/i }))
    const retried = container.querySelector('img')!
    expect(retried).toBeTruthy()
    expect(retried.getAttribute('src')).toContain('retry=1')
  })

  it('reserves the image box and shows a skeleton while a ref is in flight', async () => {
    // The bytes no longer arrive with the payload, so without a reserved box
    // the card is a sliver until the fetch lands and then displaces the page.
    mockParseToolResult.mockReturnValue({
      text: null,
      images: [{ ...refImage, width: 919, height: 1998 }],
    })
    const { container } = render(
      <ToolCallItem toolCall={createToolCall({ name: 'Read', result: 'x' })} />
    )
    await userEvent.click(screen.getByRole('button'))

    const img = container.querySelector('img')!
    expect(img).toHaveAttribute('width', '919')
    expect(img).toHaveAttribute('height', '1998')
    expect(img.parentElement).toHaveStyle({ aspectRatio: '919 / 1998' })
    expect(container.querySelector('.animate-pulse')).toBeTruthy()

    fireEvent.load(img)
    expect(container.querySelector('.animate-pulse')).toBeNull()
  })

  it('does not show a skeleton for an inline image, which needs no fetch', async () => {
    mockParseToolResult.mockReturnValue({
      text: null,
      images: [{ src: 'data:image/png;base64,abc', isRef: false }],
    })
    const { container } = render(
      <ToolCallItem toolCall={createToolCall({ name: 'Read', result: 'x' })} />
    )
    await userEvent.click(screen.getByRole('button'))
    expect(container.querySelector('.animate-pulse')).toBeNull()
  })

  it('does not corrupt an inline data URL when retried', async () => {
    // A query nonce appended to a data: URL becomes part of the base64 payload,
    // turning a working image into a broken one.
    const dataUrl = 'data:image/png;base64,iVBORw0KGgo='
    mockParseToolResult.mockReturnValue({
      text: null,
      images: [{ src: dataUrl, isRef: false }],
    })
    const { container } = render(
      <ToolCallItem toolCall={createToolCall({ name: 'Read', result: 'x' })} />
    )
    await userEvent.click(screen.getByRole('button'))
    fireEvent.error(container.querySelector('img')!)
    await userEvent.click(screen.getByRole('button', { name: /retry/i }))

    expect(container.querySelector('img')).toHaveAttribute('src', dataUrl)
  })

  it('still renders inline base64 images', async () => {
    mockParseToolResult.mockReturnValue({
      text: null,
      images: [{ src: 'data:image/png;base64,abc', isRef: false }],
    })
    const { container } = render(
      <ToolCallItem toolCall={createToolCall({ name: 'Read', result: 'x' })} />
    )
    await userEvent.click(screen.getByRole('button'))
    expect(container.querySelector('img')).toHaveAttribute('src', 'data:image/png;base64,abc')
  })
})

describe('ToolCallItem result documents', () => {
  const refPdf = {
    src: '/api/agents/a/sessions/s/media/ref-pdf',
    mimeType: 'application/pdf' as const,
    bytes: 200_000,
    title: 'report.pdf',
    isRef: true,
  }

  const originalFetch = globalThis.fetch
  const originalCreateObjectURL = URL.createObjectURL
  const originalRevokeObjectURL = URL.revokeObjectURL

  afterEach(() => {
    globalThis.fetch = originalFetch
    URL.createObjectURL = originalCreateObjectURL
    URL.revokeObjectURL = originalRevokeObjectURL
    mockParseToolResult.mockImplementation((result: unknown) => ({
      text: result != null ? String(result) : null,
      images: [],
    }))
  })

  function stubFetch(response: { ok: boolean; status: number }) {
    const fetchMock = vi.fn(async () => ({
      ...response,
      blob: async () => new Blob(['%PDF-1.7'], { type: 'application/pdf' }),
    }))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    URL.createObjectURL = vi.fn(() => 'blob:pdf-1')
    URL.revokeObjectURL = vi.fn()
    return fetchMock
  }

  it('fetches a referenced PDF only once expanded and shows it in a frame', async () => {
    const fetchMock = stubFetch({ ok: true, status: 200 })
    mockParseToolResult.mockReturnValue({ text: 'done', images: [], documents: [refPdf] })
    const { container } = render(
      <ToolCallItem toolCall={createToolCall({ name: 'Read', result: 'done' })} />
    )
    expect(fetchMock).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button'))
    expect(fetchMock).toHaveBeenCalledWith(refPdf.src, expect.anything())
    const frame = await screen.findByTitle('report.pdf')
    expect(frame.tagName).toBe('IFRAME')
    expect(frame).toHaveAttribute('src', 'blob:pdf-1')
    expect(container.querySelector('[data-testid="tool-result-document"]')).toHaveTextContent('195 KB')
  })

  it('offers a retry when the PDF cannot be fetched', async () => {
    const fetchMock = stubFetch({ ok: false, status: 410 })
    mockParseToolResult.mockReturnValue({ text: 'done', images: [], documents: [refPdf] })
    render(<ToolCallItem toolCall={createToolCall({ name: 'Read', result: 'done' })} />)
    await userEvent.click(screen.getByRole('button'))

    expect(await screen.findByText(/couldn't load report\.pdf/i)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /retry/i }))
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
