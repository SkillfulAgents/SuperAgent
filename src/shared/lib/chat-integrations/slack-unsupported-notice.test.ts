import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { UserRequestEvent } from '@shared/lib/tool-definitions/types'
import { SlackConnector } from './slack-connector'
import type { AppLinkContext } from './utils'

// ── Helpers ────────────────────────────────────────────────────────────

function makeConnector(appLink?: AppLinkContext) {
  const connector = new SlackConnector({ botToken: 'xoxb-fake', appToken: 'xapp-fake' }, appLink)
  const postMessage = vi.fn().mockResolvedValue({ ok: true, ts: '1000.001' })
  ;(connector as any).app = {
    client: {
      chat: { postMessage, update: vi.fn().mockResolvedValue({ ok: true }) },
      reactions: { remove: vi.fn().mockResolvedValue({}) },
    },
  }
  return { connector, postMessage }
}

const SECRET_REQUEST: UserRequestEvent = {
  type: 'secret_request',
  toolUseId: 'tu-1',
  secretName: 'OPENAI_API_KEY',
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('SlackConnector — unsupported-request notice', () => {
  let desktop: AppLinkContext

  beforeEach(() => {
    desktop = { isDesktop: true, url: 'superagent://agent/demo' }
  })

  it('links to the conversation that raised the request', async () => {
    const { connector, postMessage } = makeConnector(desktop)

    await connector.sendUserRequestCard('C123', SECRET_REQUEST, 'sess-1')

    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'C123',
      text: expect.stringContaining('superagent://agent/demo/sessions/sess-1'),
      mrkdwn: true,
    }))
  })

  it('falls back to the agent-home link without a sessionId', async () => {
    const { connector, postMessage } = makeConnector(desktop)

    await connector.sendUserRequestCard('C123', SECRET_REQUEST)

    const { text } = postMessage.mock.calls[0][0]
    expect(text).toContain('superagent://agent/demo')
    expect(text).not.toContain('/sessions/')
  })

  it('renders the web link and drops the desktop wording on a cloud host', async () => {
    const { connector, postMessage } = makeConnector({
      isDesktop: false,
      url: 'https://app.example.com/agents/demo',
    })

    await connector.sendUserRequestCard('C123', SECRET_REQUEST, 'sess-1')

    const { text } = postMessage.mock.calls[0][0]
    expect(text).toContain('https://app.example.com/agents/demo/sessions/sess-1')
    expect(text).not.toContain('desktop')
  })

  // The regression this guards: Slack will not render `_…_` italic when a URL
  // abuts the closing underscore, so wrapping the notice leaves the markers in
  // the message as literal characters right where the link is.
  it('sends the notice unwrapped so the trailing URL is not broken by italic markers', async () => {
    const { connector, postMessage } = makeConnector(desktop)

    await connector.sendUserRequestCard('C123', SECRET_REQUEST, 'sess-1')

    const { text } = postMessage.mock.calls[0][0]
    expect(text.startsWith('_')).toBe(false)
    expect(text.endsWith('superagent://agent/demo/sessions/sess-1')).toBe(true)
  })

  it('applies the same link + unwrapped rule to the unknown-event fallback', async () => {
    const { connector, postMessage } = makeConnector(desktop)

    await connector.sendUserRequestCard('C123', { type: 'not_a_real_request' } as unknown as UserRequestEvent, 'sess-1')

    const { text } = postMessage.mock.calls[0][0]
    expect(text).toContain('superagent://agent/demo/sessions/sess-1')
    expect(text.startsWith('_')).toBe(false)
    expect(text.endsWith('_')).toBe(false)
  })
})
