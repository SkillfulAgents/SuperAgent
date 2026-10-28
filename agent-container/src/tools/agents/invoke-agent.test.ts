import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockCallHost = vi.fn()
vi.mock('./host-client', async () => {
  const actual = await vi.importActual<typeof import('./host-client')>('./host-client')
  return { ...actual, callHost: (...args: unknown[]) => mockCallHost(...args) }
})

describe('invoke_agent attachments', () => {
  beforeEach(() => mockCallHost.mockReset())

  it('limits attachment input to 10 paths', async () => {
    const { makeInvokeAgentTool } = await import('./invoke-agent')
    const agentTool = makeInvokeAgentTool(() => 'caller-session') as {
      inputSchema: { attachments: { parse: (value: unknown) => unknown } }
    }

    expect(() => agentTool.inputSchema.attachments.parse(Array.from({ length: 10 }, (_, i) => `file-${i}`)))
      .not.toThrow()
    expect(() => agentTool.inputSchema.attachments.parse(Array.from({ length: 11 }, (_, i) => `file-${i}`)))
      .toThrow()
  })

  it('forwards attachment paths and caller session attribution', async () => {
    mockCallHost.mockResolvedValue({ sessionId: 'target-session', status: 'running' })
    const { makeInvokeAgentTool } = await import('./invoke-agent')
    const agentTool = makeInvokeAgentTool(() => 'caller-session')

    await (agentTool as { handler: (args: unknown) => Promise<unknown> }).handler({
      slug: 'target',
      prompt: 'Review these',
      attachments: ['/workspace/a.bin', 'relative/b.txt'],
    })

    expect(mockCallHost).toHaveBeenCalledWith(
      'invoke',
      {
        slug: 'target',
        prompt: 'Review these',
        attachments: ['/workspace/a.bin', 'relative/b.txt'],
      },
      expect.anything(),
      { callerSessionId: 'caller-session' },
    )
  })
})
