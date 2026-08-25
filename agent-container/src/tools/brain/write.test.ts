import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockCallBrainHost = vi.fn()
const mockGetBrainCurator = vi.fn()
const mockCallHost = vi.fn()

vi.mock('./host-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./host-client')>()
  return {
    ...actual,
    callBrainHost: (...args: unknown[]) => mockCallBrainHost(...args),
    getBrainCurator: (...args: unknown[]) => mockGetBrainCurator(...args),
  }
})

vi.mock('../agents/host-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../agents/host-client')>()
  return {
    ...actual,
    callHost: (...args: unknown[]) => mockCallHost(...args),
  }
})

import { REQUEST_PROMPT } from './request-prompt'
import { persistResponseSchema } from './schemas'
import { executeBrainWrite } from './write'

describe('executeBrainWrite', () => {
  const prevSlug = process.env.SUPERAGENT_AGENT_SLUG

  beforeEach(() => {
    mockCallBrainHost.mockReset()
    mockGetBrainCurator.mockReset()
    mockCallHost.mockReset()
    process.env.SUPERAGENT_AGENT_SLUG = 'sales-bot'
  })

  afterEach(() => {
    if (prevSlug === undefined) delete process.env.SUPERAGENT_AGENT_SLUG
    else process.env.SUPERAGENT_AGENT_SLUG = prevSlug
  })

  it('reports a curator write', async () => {
    mockCallBrainHost.mockResolvedValue({
      status: 'wrote',
      name: 'pricing-decisions.md',
      updatedAt: '2026-08-21T00:00:00.000Z',
    })
    const result = await executeBrainWrite({ name: 'pricing-decisions', body: '# Why\n' }, 'sess-1')
    expect(result.isError).toBeUndefined()
    expect(result.content[0].text).toBe('Wrote pricing-decisions.md.')
    expect(mockCallBrainHost).toHaveBeenCalledWith(
      'write',
      { name: 'pricing-decisions', body: '# Why\n' },
      persistResponseSchema,
    )
    expect(mockCallHost).not.toHaveBeenCalled()
  })

  it('invokes the curator on the x-agent path', async () => {
    mockGetBrainCurator.mockResolvedValue('curator-bot')
    mockCallHost.mockResolvedValue({
      sessionId: 'curator-sess-1',
      status: 'completed',
      lastMessage: 'Wrote pricing-decisions.md',
    })
    const completed = await executeBrainWrite({ request: 'Remember pricing' }, 'sess-1')
    expect(completed.content[0].text).toBe([
      'session_id: curator-sess-1',
      'status: completed',
      '',
      '--- last message from agent ---',
      'Wrote pricing-decisions.md',
    ].join('\n'))
    expect(mockCallBrainHost).not.toHaveBeenCalled()
    expect(mockCallHost).toHaveBeenCalledWith(
      'invoke',
      {
        slug: 'curator-bot',
        prompt: REQUEST_PROMPT('Remember pricing', 'sales-bot', 'sess-1'),
        sync: true,
      },
      { callerSessionId: 'sess-1' },
    )

    mockCallHost.mockResolvedValue({ sessionId: 'curator-sess-1', status: 'running' })
    const running = await executeBrainWrite({ request: 'Remember pricing' }, 'sess-1')
    expect(running.content[0].text).toBe('session_id: curator-sess-1\nstatus: running')
  })

  it('surfaces no curator as a tool error', async () => {
    mockGetBrainCurator.mockResolvedValue(null)
    const result = await executeBrainWrite({ request: 'Remember pricing' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toBe('Failed to write brain page: No curator')
    expect(mockCallHost).not.toHaveBeenCalled()
  })

  it('tells the curator to persist instead of invoking itself', async () => {
    mockGetBrainCurator.mockResolvedValue('sales-bot')
    const result = await executeBrainWrite({ request: 'Remember pricing' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toBe('You are the curator. Write or delete a named page.')
    expect(mockCallHost).not.toHaveBeenCalled()
  })
})
