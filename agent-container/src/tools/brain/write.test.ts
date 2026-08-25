import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockCallHost = vi.fn()
const mockReadFileSync = vi.fn<(p: string, enc: string) => string>()

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return { ...actual, readFileSync: (p: string, enc: string) => (p === '/brains/global/CURATOR' ? mockReadFileSync(p, enc) : actual.readFileSync(p, enc)) }
})

vi.mock('../agents/host-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../agents/host-client')>()
  return {
    ...actual,
    callHost: (...args: unknown[]) => mockCallHost(...args),
  }
})

import { REQUEST_PROMPT } from './request-prompt'
import { brainWriteShape } from './tools'
import { executeBrainWrite } from './write'

describe('executeBrainWrite', () => {
  const prevSlug = process.env.SUPERAGENT_AGENT_SLUG

  beforeEach(() => {
    mockCallHost.mockReset()
    mockReadFileSync.mockReset()
    process.env.SUPERAGENT_AGENT_SLUG = 'sales-bot'
  })

  afterEach(() => {
    if (prevSlug === undefined) delete process.env.SUPERAGENT_AGENT_SLUG
    else process.env.SUPERAGENT_AGENT_SLUG = prevSlug
  })

  it('invokes the curator on the x-agent path', async () => {
    mockReadFileSync.mockReturnValue('curator-bot\n')
    mockCallHost.mockResolvedValue({
      sessionId: 'curator-sess-1',
      status: 'completed',
      lastMessage: 'Wrote pricing-decisions.md',
    })
    const completed = await executeBrainWrite('Remember pricing', 'sess-1')
    expect(completed.content[0].text).toBe([
      'session_id: curator-sess-1',
      'status: completed',
      '',
      '--- last message from agent ---',
      'Wrote pricing-decisions.md',
    ].join('\n'))
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
    const running = await executeBrainWrite('Remember pricing', 'sess-1')
    expect(running.content[0].text).toBe('session_id: curator-sess-1\nstatus: running')
  })

  it('surfaces no curator as a tool error', async () => {
    mockReadFileSync.mockImplementation(() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) })
    const missing = await executeBrainWrite('Remember pricing')
    expect(missing.isError).toBe(true)
    expect(missing.content[0].text).toBe('Failed to write brain page: No curator')
    expect(mockCallHost).not.toHaveBeenCalled()

    mockReadFileSync.mockReturnValue('  \n')
    const blank = await executeBrainWrite('Remember pricing')
    expect(blank.isError).toBe(true)
    expect(blank.content[0].text).toBe('Failed to write brain page: No curator')
    expect(mockCallHost).not.toHaveBeenCalled()
  })

  it('rejects a request with no text', async () => {
    const result = await executeBrainWrite('   ', 'sess-1')
    expect(result.isError).toBe(true)
    expect(mockCallHost).not.toHaveBeenCalled()
  })

  it('exposes request as the only parameter', () => {
    expect(Object.keys(brainWriteShape)).toEqual(['request'])
  })
})
