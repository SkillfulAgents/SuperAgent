import { describe, it, expect } from 'vitest'
import { attachCallOutcomes, summarizeCallOutcome, taggedCallIds, type ProxyCallRecord } from './call-outcome'
import type { TransformedMessage } from '@shared/lib/utils/message-transform'

const request = (extra: Partial<ProxyCallRecord> = {}): ProxyCallRecord => ({
  statusCode: 200, errorMessage: null, policyDecision: 'allow', ...extra,
})

describe('summarizeCallOutcome', () => {
  it('fails a call on what the proxy saw, whatever the shell printed', () => {
    expect(summarizeCallOutcome([request({ statusCode: 404, errorMessage: 'Upstream returned 404' })]))
      .toEqual({ requests: 1, failed: 1, error: 'Not found' })
    expect(summarizeCallOutcome([request({ statusCode: 409, errorMessage: 'Account replaced for this agent by a user' })])?.error)
      .toBe('Account replaced for this agent by a user')
    expect(summarizeCallOutcome([request({ statusCode: null, policyDecision: 'denied_by_user' })])?.error)
      .toBe('user-denied')
    expect(summarizeCallOutcome([request({ errorMessage: '  ' })])).toEqual({ requests: 1, failed: 0 })
  })

  it('lets the last request decide and counts the earlier failures', () => {
    expect(summarizeCallOutcome([request(), request({ statusCode: 404 }), request()])).toEqual({ requests: 3, failed: 1 })
    expect(summarizeCallOutcome([request(), request({ statusCode: 404 })])?.error).toBe('Not found')
  })
})

describe('attachCallOutcomes', () => {
  const at = (iso: string) => new Date(`2026-10-15T${iso}Z`)
  const message = (id: string, createdAt: Date, toolCalls: TransformedMessage['toolCalls']): TransformedMessage =>
    ({ id, type: 'assistant', content: { text: '' }, toolCalls, createdAt })
  const stamped = (toolUseId: string, createdAt: Date, extra: Partial<ProxyCallRecord> = {}) =>
    ({ ...request(extra), toolUseId, createdAt })

  it('counts a call\'s requests until its result, and skips background calls', () => {
    const items = [
      message('m1', at('10:00:00'), [
        { id: 'toolu_a', name: 'Bash', input: { command: 'curl …' }, resultAt: at('10:03:00') },
        { id: 'toolu_bg', name: 'Bash', input: { command: 'curl …', run_in_background: true }, resultAt: at('10:00:01') },
        { id: 'toolu_moved', name: 'Bash', input: { command: 'curl …' }, backgroundTaskId: 'b1', resultAt: at('10:00:01') },
      ]),
      // A message queued while the call runs does not end its window.
      message('m2', at('10:01:00'), []),
    ]
    expect(taggedCallIds(items)).toEqual(['toolu_a'])

    attachCallOutcomes(items, [
      stamped('toolu_a', at('10:00:02')),
      stamped('toolu_a', at('10:02:30'), { statusCode: 404 }),
      // A saved address stamping a request an hour later belongs to a later call.
      stamped('toolu_a', at('11:00:00')),
    ])
    expect(items[0].toolCalls[0].proxyOutcome).toEqual({ requests: 2, failed: 1, error: 'Not found' })
  })

  it('leaves a running call alone', () => {
    const items = [message('m1', at('10:00:00'), [{ id: 'toolu_a', name: 'Bash', input: { command: 'curl …' } }])]
    expect(taggedCallIds(items)).toEqual([])
    attachCallOutcomes(items, [stamped('toolu_a', at('10:00:01'), { statusCode: 404 })])
    expect(items[0].toolCalls[0].proxyOutcome).toBeUndefined()
  })
})
