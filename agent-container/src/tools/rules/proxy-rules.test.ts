import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { proposeAndWait } from './proxy-rules'

describe('rule proposals', () => {
  let replies: Array<() => Response>
  let calls: Array<{ op: string; body: Record<string, unknown> }>

  beforeEach(() => {
    vi.useFakeTimers()
    process.env.SUPERAGENT_HOST_API_URL = 'http://host/api'
    process.env.PROXY_TOKEN = 'secret'
    replies = []
    calls = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ op: url.split('/').pop()!, body: JSON.parse(String(init.body)) })
      const reply = replies.shift()
      if (!reply) throw new Error('no reply queued')
      return reply()
    }))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    delete process.env.SUPERAGENT_HOST_API_URL
    delete process.env.PROXY_TOKEN
  })

  const pending = () => Response.json({ proposalId: 'p1', status: 'pending' }, { status: 202 })
  const proxyError = () => new Response('<html>502 Bad Gateway</html>', { status: 502 })

  it('waits on the proposal until the host answers', async () => {
    replies.push(pending, pending, pending, () => Response.json({ ok: true, rule: { id: 'r1' } }))
    const result = await proposeAndWait('create', { kind: 'api', targetId: 'a1' })
    expect(result).toMatchObject({ ok: true, status: 200, data: { ok: true, rule: { id: 'r1' } } })
    expect(calls.map((c) => c.op)).toEqual(['create', 'wait', 'wait', 'wait'])
    expect(calls[1].body).toEqual({ proposalId: 'p1' })
  })

  it('keeps waiting through a proxy error page instead of reporting it', async () => {
    replies.push(pending, proxyError, () => Response.json({ error: 'upstream proxy timeout' }, { status: 504 }),
      () => Response.json({ error: 'denied_by_user' }, { status: 403 }))
    const result = proposeAndWait('create', {})
    await vi.runAllTimersAsync()
    expect(await result).toMatchObject({ ok: false, status: 403, data: { error: 'denied_by_user' } })
    expect(calls.map((c) => c.op)).toEqual(['create', 'wait', 'wait', 'wait'])
  })

  it('returns errors the host decided on at once', async () => {
    replies.push(() => Response.json({ error: 'too_many_rules' }, { status: 422 }))
    expect(await proposeAndWait('create', {})).toMatchObject({ status: 422, data: { error: 'too_many_rules' } })
    replies.push(pending, () => Response.json({ error: 'unknown_proposal' }, { status: 404 }))
    expect(await proposeAndWait('delete', { ruleId: 'r1' })).toMatchObject({ status: 404 })
  })

  it('withdraws the proposal when the call is cancelled', async () => {
    const controller = new AbortController()
    replies.push(pending, () => {
      controller.abort()
      throw new DOMException('aborted', 'AbortError')
    }, () => Response.json({ ok: true }))
    const result = await proposeAndWait('create', {}, controller.signal)
    expect(result).toMatchObject({ ok: false, data: { error: 'cancelled' } })
    expect(calls.map((c) => c.op)).toEqual(['create', 'wait', 'cancel'])
    expect(calls[2].body).toEqual({ proposalId: 'p1' })
  })

  it('gives up after repeated failures and withdraws the proposal', async () => {
    replies.push(pending, proxyError, proxyError, proxyError, proxyError, proxyError, proxyError, () => Response.json({ ok: true }))
    const result = proposeAndWait('create', {})
    await vi.runAllTimersAsync()
    expect(await result).toMatchObject({ ok: false, status: 502 })
    expect(calls.map((c) => c.op)).toEqual(['create', 'wait', 'wait', 'wait', 'wait', 'wait', 'wait', 'cancel'])
  })
})
