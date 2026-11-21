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

  it('forwards a model and effort pick', async () => {
    mockCallHost.mockResolvedValue({ sessionId: 'target-session', status: 'running' })
    const { makeInvokeAgentTool } = await import('./invoke-agent')
    const agentTool = makeInvokeAgentTool(() => 'caller-session')

    await (agentTool as { handler: (args: unknown) => Promise<unknown> }).handler({ slug: 'target', prompt: 'Review', model: 'sonnet', effort: 'high', speed: 'fast' })

    expect(mockCallHost).toHaveBeenCalledWith('invoke', { slug: 'target', prompt: 'Review', model: 'sonnet', effort: 'high', speed: 'fast' }, expect.anything(), expect.anything())
  })
})

describe('list_models', () => {
  it('lists models for the calling session', async () => {
    mockCallHost.mockResolvedValue({ accounts: [{ id: 'chatgpt', name: 'ChatGPT', provider: 'codex-subscription', models: [{ id: 'gpt-6-astra', label: 'GPT-6 Astra', alias: 'gpt-astra' }] }] })
    const { makeListModelsTool } = await import('./list-models')
    const listTool = makeListModelsTool(() => 'caller-session')
    const result = await (listTool as { handler: (args: unknown) => Promise<{ content: { text: string }[] }> }).handler({})
    const { listModelsResultSchema } = await import('./host-response-schemas')
    expect(mockCallHost).toHaveBeenCalledWith('models', {}, listModelsResultSchema, { callerSessionId: 'caller-session' })
    expect(result.content[0].text).toContain('"alias": "gpt-astra"')
  })

  it('says there is nothing to list when no accounts come back', async () => {
    mockCallHost.mockResolvedValue({ accounts: [] })
    const { makeListModelsTool } = await import('./list-models')
    const result = await (makeListModelsTool(() => 'caller-session') as { handler: (args: unknown) => Promise<{ content: { text: string }[] }> }).handler({})
    expect(result.content[0].text).toBe('No model accounts to list.')
  })
})
