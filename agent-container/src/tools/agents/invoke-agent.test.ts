import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockCallHost = vi.fn()
vi.mock('./host-client', async () => {
  const actual = await vi.importActual<typeof import('./host-client')>('./host-client')
  return { ...actual, callHost: (...args: unknown[]) => mockCallHost(...args) }
})

describe('invoke_agent result rendering', () => {
  beforeEach(() => {
    mockCallHost.mockReset()
  })

  async function invoke(args: { slug: string; prompt: string; session_id?: string; sync?: boolean }) {
    const { makeInvokeAgentTool } = await import('./invoke-agent')
    const tool = makeInvokeAgentTool(() => 'caller-session')
    return (tool as { handler: (a: unknown) => Promise<{ content: Array<{ text: string }> }> }).handler(args)
  }

  it('tells the agent to end its turn when the host registered a wake', async () => {
    mockCallHost.mockResolvedValue({ sessionId: 's1', status: 'running', wake: true })
    const text = (await invoke({ slug: 'b', prompt: 'go' })).content[0].text
    expect(text).toContain('status: running')
    expect(text).toMatch(/End your turn/)
    expect(text).not.toMatch(/poll/i)
  })

  it('surfaces the host note when registration failed', async () => {
    mockCallHost.mockResolvedValue({ sessionId: 's1', status: 'running', error: 'Could not register a wake for this session (db locked); poll get_agent_session_transcript instead.' })
    const text = (await invoke({ slug: 'b', prompt: 'go' })).content[0].text
    expect(text).toContain('note: Could not register a wake')
    expect(text).not.toMatch(/End your turn/)
  })
})
