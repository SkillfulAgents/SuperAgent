import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockCallHost = vi.fn()
vi.mock('./host-client', async () => {
  const actual = await vi.importActual<typeof import('./host-client')>('./host-client')
  return {
    ...actual,
    callHost: (...args: unknown[]) => mockCallHost(...args),
  }
})

describe('get_agent_session_transcript limit rendering', () => {
  beforeEach(() => {
    mockCallHost.mockReset()
  })

  async function invoke(args: {
    slug: string
    session_id: string
    limit?: number
    full_transcript?: boolean
  }) {
    const { getSessionTranscriptTool } = await import('./get-session-transcript')
    return (getSessionTranscriptTool as { handler: (a: unknown) => Promise<{ content: Array<{ text: string }> }> }).handler(args)
  }

  it('forwards limit and numbers from the host total', async () => {
    mockCallHost.mockResolvedValue({
      status: 'idle',
      total: 5,
      deliveredFiles: [],
      messages: [
        { role: 'assistant', content: 'two' },
        { role: 'assistant', content: 'three' },
      ],
    })

    const result = await invoke({ slug: 'target', session_id: 'sess-1', limit: 2 })

    expect(mockCallHost).toHaveBeenCalledWith(
      'get-transcript',
      {
        slug: 'target',
        sessionId: 'sess-1',
        sync: false,
        limit: 2,
      },
      expect.anything(),
    )
    const text = result.content[0].text
    expect(text).toContain('showing last 2 of 5')
    expect(text).toContain('--- #4 assistant ---')
    expect(text).toContain('--- #5 assistant ---')
    expect(text).toContain('two')
    expect(text).toContain('three')
  })

  it('forwards full_transcript when set', async () => {
    mockCallHost.mockResolvedValue({
      status: 'idle',
      total: 1,
      deliveredFiles: [],
      messages: [{ role: 'assistant', content: '[tool_use: Bash]', toolName: 'Bash' }],
    })

    await invoke({ slug: 'target', session_id: 'sess-1', full_transcript: true })

    expect(mockCallHost).toHaveBeenCalledWith(
      'get-transcript',
      {
        slug: 'target',
        sessionId: 'sess-1',
        sync: false,
        fullTranscript: true,
      },
      expect.anything(),
    )
  })

  it('prints exact download instructions when the message page is empty', async () => {
    mockCallHost.mockResolvedValue({
      status: 'idle',
      total: 0,
      messages: [],
      deliveredFiles: [{ deliveryId: 'delivery-1', filename: 'report.bin', sizeBytes: 17 }],
    })

    const result = await invoke({ slug: 'target', session_id: 'sess-1', limit: 1 })
    const text = result.content[0].text

    expect(text).toContain('(no messages)')
    expect(text).toContain('"report.bin" (17 bytes)')
    expect(text).toContain('download_agent_file arguments: {"slug":"target","session_id":"sess-1","delivery_id":"delivery-1"}')
  })

  it('prints delivered files independently of a paginated message view', async () => {
    mockCallHost.mockResolvedValue({
      status: 'running',
      total: 20,
      messages: [{ role: 'assistant', content: 'latest' }],
      deliveredFiles: [{ deliveryId: 'delivery-2', filename: 'data.csv', sizeBytes: 5 }],
    })

    const result = await invoke({ slug: 'target', session_id: 'sess-2', limit: 1 })
    const text = result.content[0].text

    expect(text).toContain('showing last 1 of 20')
    expect(text).toContain('delivery_id":"delivery-2"')
  })
})
