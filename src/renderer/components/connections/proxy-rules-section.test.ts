import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockApiFetch } = vi.hoisted(() => ({ mockApiFetch: vi.fn() }))
vi.mock('@renderer/lib/api', () => ({ apiFetch: mockApiFetch }))

import { authorRuleJob } from './proxy-rules-section'

describe('authorRuleJob', () => {
  let replies: Array<() => Response>

  beforeEach(() => {
    vi.useFakeTimers()
    replies = []
    mockApiFetch.mockReset()
    mockApiFetch.mockImplementation(async () => {
      const reply = replies.shift()
      if (!reply) throw new Error('no reply queued')
      return reply()
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const started = () => Response.json({ jobId: 'job-1' }, { status: 202 })
  const pending = () => Response.json({ status: 'pending' }, { status: 202 })
  const question = () => Response.json({ type: 'question', question: 'Which domain?' })

  function run() {
    const result = authorRuleJob('api', 'acct', { description: 'x', clarifications: [] }, new AbortController().signal)
    result.catch(() => {})
    return result
  }

  it('polls the job until it finishes', async () => {
    replies.push(started, pending, pending, question)
    const result = run()
    await vi.runAllTimersAsync()
    expect(await result).toEqual({ type: 'question', question: 'Which domain?', jobId: 'job-1' })
    expect(mockApiFetch.mock.calls.map(([path]) => path)).toEqual([
      '/api/proxy-rules/api/acct/author',
      '/api/proxy-rules/api/acct/author/job-1',
      '/api/proxy-rules/api/acct/author/job-1',
      '/api/proxy-rules/api/acct/author/job-1',
    ])
  })

  it('keeps polling through proxy failures, JSON or not', async () => {
    replies.push(
      started,
      () => new Response('<html>504 Gateway Time-out</html>', { status: 504 }),
      () => Response.json({ error: 'cloud_workspace_unreachable', message: 'The cloud workspace could not be reached.' }, { status: 502 }),
      question,
    )
    const result = run()
    await vi.runAllTimersAsync()
    expect(await result).toMatchObject({ type: 'question' })
  })

  it('reports a failure the job itself returned, without retrying', async () => {
    replies.push(started, () => Response.json({ type: 'failed', error: 'The model returned malformed JSON' }), question)
    const result = run()
    await vi.runAllTimersAsync()
    await expect(result).rejects.toThrow('The model returned malformed JSON')
    expect(mockApiFetch).toHaveBeenCalledTimes(2)
  })

  it('gives up after repeated proxy failures with the proxy\'s message', async () => {
    const unreachable = () => Response.json({ error: 'cloud_workspace_unreachable', message: 'The cloud workspace could not be reached.' }, { status: 502 })
    replies.push(started, unreachable, unreachable, unreachable, unreachable, question)
    const result = run()
    await vi.runAllTimersAsync()
    await expect(result).rejects.toThrow('The cloud workspace could not be reached.')
  })
})
