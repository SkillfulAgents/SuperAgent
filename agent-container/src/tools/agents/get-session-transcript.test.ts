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

  async function invoke(args: { slug: string; session_id: string; limit?: number }) {
    const { getSessionTranscriptTool } = await import('./get-session-transcript')
    return (getSessionTranscriptTool as { handler: (a: unknown) => Promise<{ content: Array<{ text: string }> }> }).handler(args)
  }

  it('forwards limit and numbers from the host total', async () => {
    mockCallHost.mockResolvedValue({
      status: 'idle',
      total: 5,
      messages: [
        { role: 'assistant', content: 'two' },
        { role: 'assistant', content: 'three' },
      ],
    })

    const result = await invoke({ slug: 'target', session_id: 'sess-1', limit: 2 })

    expect(mockCallHost).toHaveBeenCalledWith('get-transcript', {
      slug: 'target',
      sessionId: 'sess-1',
      sync: false,
      limit: 2,
    })
    const text = result.content[0].text
    expect(text).toContain('showing last 2 of 5')
    expect(text).toContain('--- #4 assistant ---')
    expect(text).toContain('--- #5 assistant ---')
    expect(text).toContain('two')
    expect(text).toContain('three')
  })
})
