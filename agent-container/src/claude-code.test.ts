import { describe, it, expect } from 'vitest'
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import {
  AGENT_BROWSER_BASH_WARNING,
  MessageQueue,
  resolveRemoteMcpProxyUrl,
  resultNeedsResumeErrorFallback,
  startsWithAgentBrowserCommand,
  stillQueuedFromReceipt,
} from './claude-code'

describe('resolveRemoteMcpProxyUrl', () => {
  it('re-origins a direct host-app proxyUrl onto the talk-back base', () => {
    expect(
      resolveRemoteMcpProxyUrl(
        'http://10.20.108.29:3000/api/mcp-proxy/agent/mcp-1',
        'http://127.0.0.1:9412/api',
      ),
    ).toBe('http://127.0.0.1:9412/api/mcp-proxy/agent/mcp-1')
  })

  it('is a no-op when the talk-back origin already matches', () => {
    expect(
      resolveRemoteMcpProxyUrl(
        'http://host.docker.internal:3000/api/mcp-proxy/agent/mcp-1',
        'http://host.docker.internal:3000/api',
      ),
    ).toBe('http://host.docker.internal:3000/api/mcp-proxy/agent/mcp-1')
  })

  it('returns the original URL when SUPERAGENT_HOST_API_URL is unset or invalid', () => {
    const direct = 'http://10.20.108.29:3000/api/mcp-proxy/agent/mcp-1'
    expect(resolveRemoteMcpProxyUrl(direct, undefined)).toBe(direct)
    expect(resolveRemoteMcpProxyUrl(direct, 'not-a-url')).toBe(direct)
  })
})

describe('startsWithAgentBrowserCommand', () => {
  it.each([
    'agent-browser open https://example.com',
    '  agent-browser snapshot',
    'which agent-browser',
    '\twhich   agent-browser; agent-browser --help',
  ])('matches a direct agent-browser Bash request: %s', (command) => {
    expect(startsWithAgentBrowserCommand(command)).toBe(true)
  })

  it.each([
    'echo agent-browser',
    'env | grep -i browser',
    'which agent-browser-helper',
    'agent-browser-helper open https://example.com',
    '',
    undefined,
  ])('ignores unrelated Bash requests: %s', (command) => {
    expect(startsWithAgentBrowserCommand(command)).toBe(false)
  })

  it('uses a strong but explicitly non-blocking warning', () => {
    expect(AGENT_BROWSER_BASH_WARNING).toContain('STRONG WARNING')
    expect(AGENT_BROWSER_BASH_WARNING).toContain('still allowed')
    expect(AGENT_BROWSER_BASH_WARNING).toContain('mcp__browser__browser_*')
  })
})

describe('resultNeedsResumeErrorFallback', () => {
  it('wants the fallback only when the error result carries no text at all', () => {
    expect(resultNeedsResumeErrorFallback({})).toBe(true)
    expect(resultNeedsResumeErrorFallback({ error: '', message: '', result: '' })).toBe(true)
  })

  it('keeps existing error/message text untouched', () => {
    expect(resultNeedsResumeErrorFallback({ error: 'boom' })).toBe(false)
    expect(resultNeedsResumeErrorFallback({ message: 'exec failed' })).toBe(false)
  })

  it('never injects the resume copy onto a gracefully interrupted turn', () => {
    // A graceful interrupt yields an error-shaped, textless result with
    // terminal_reason aborted_tools/aborted_streaming — a deliberate stop.
    expect(resultNeedsResumeErrorFallback({ terminal_reason: 'aborted_tools' })).toBe(false)
    expect(resultNeedsResumeErrorFallback({ terminal_reason: 'aborted_streaming' })).toBe(false)
  })

  it('respects result text — the modern is_error shape explains itself there', () => {
    // e.g. terminal_reason: api_error from a nonexistent model puts the
    // human-readable explanation in `result`; injecting the "session
    // corrupted" copy next to it would surface the wrong error to the host.
    expect(
      resultNeedsResumeErrorFallback({
        result: "There's an issue with the selected model (claude-nonexistent-9).",
      })
    ).toBe(false)
  })
})

describe('stillQueuedFromReceipt', () => {
  it('extracts still_queued uuids from a modern receipt', () => {
    expect(stillQueuedFromReceipt({ still_queued: ['u1', 'u2'] })).toEqual(['u1', 'u2'])
  })

  it('treats old-CLI empty receipts as nothing known, not nothing queued', () => {
    expect(stillQueuedFromReceipt(undefined)).toEqual([])
    expect(stillQueuedFromReceipt({})).toEqual([])
  })

  it('degrades malformed receipts to empty instead of throwing', () => {
    expect(stillQueuedFromReceipt({ still_queued: 'u1' })).toEqual([])
    expect(stillQueuedFromReceipt({ still_queued: [42] })).toEqual([])
    expect(stillQueuedFromReceipt('garbage')).toEqual([])
  })
})

describe('MessageQueue.drain', () => {
  const userMessage = (uuid: string): SDKUserMessage =>
    ({
      type: 'user',
      uuid,
      session_id: 's1',
      message: { role: 'user', content: 'hi' },
      parent_tool_use_id: null,
    }) as SDKUserMessage

  it('empties the buffer and returns the messages the SDK never saw', () => {
    const q = new MessageQueue()
    q.push(userMessage('u1'))
    q.push(userMessage('u2'))

    const drained = q.drain()
    expect(drained.map((m) => m.uuid)).toEqual(['u1', 'u2'])
    // Buffer is now empty — a second drain finds nothing.
    expect(q.drain()).toEqual([])
  })

  it('does not return messages already pulled by a consumer', async () => {
    const q = new MessageQueue()
    q.push(userMessage('u1'))
    const it = q[Symbol.asyncIterator]()
    await it.next() // SDK pulled u1
    q.push(userMessage('u2'))
    expect(q.drain().map((m) => m.uuid)).toEqual(['u2'])
  })
})
