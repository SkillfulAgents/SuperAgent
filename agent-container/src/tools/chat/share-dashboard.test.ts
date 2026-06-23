import { describe, it, expect, vi, beforeEach } from 'vitest'
import { XAgentError } from './host-client'
import { shareDashboardHandler, shareDashboardInput } from './share-dashboard'

vi.mock('./host-client', async (orig) => ({
  ...(await orig()),
  callChatHost: vi.fn(),
}))

import { callChatHost } from './host-client'

describe('shareDashboardHandler', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('success (button): calls callChatHost with correct args and tells the agent the user can tap the button', async () => {
    vi.mocked(callChatHost).mockResolvedValue({ chatId: 'chat1', delivery: 'button' })

    const result = await shareDashboardHandler({ slug: 'weekly-report' })

    expect(callChatHost).toHaveBeenCalledWith('share-dashboard', {
      slug: 'weekly-report',
      integration_id: undefined,
      chat_id: undefined,
    })
    expect(result.isError).toBeFalsy()
    expect(result.content[0].text).toContain('weekly-report')
    expect(result.content[0].text).toContain('Open dashboard')
  })

  it('forwards the agent-supplied emoji and caption to the host', async () => {
    vi.mocked(callChatHost).mockResolvedValue({ chatId: 'chat1', delivery: 'button' })

    await shareDashboardHandler({ slug: 'weekly-report', emoji: '⚽', caption: 'Live group standings + bracket' })

    expect(callChatHost).toHaveBeenCalledWith('share-dashboard', {
      slug: 'weekly-report',
      emoji: '⚽',
      caption: 'Live group standings + bracket',
      integration_id: undefined,
      chat_id: undefined,
    })
  })

  it('success (text fallback): tells the agent a plain-text message was sent with no button', async () => {
    vi.mocked(callChatHost).mockResolvedValue({ chatId: 'chat1', delivery: 'text' })

    const result = await shareDashboardHandler({ slug: 'weekly-report' })

    expect(result.isError).toBeFalsy()
    expect(result.content[0].text).toContain('weekly-report')
    expect(result.content[0].text).toContain('plain-text')
    expect(result.content[0].text).not.toContain('tap')
  })

  it('server error: returns isError result containing the server message', async () => {
    vi.mocked(callChatHost).mockRejectedValue(new XAgentError(400, 'No active Telegram integration for this agent'))

    const result = await shareDashboardHandler({ slug: 'x' })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('No active Telegram integration for this agent')
  })
})

describe('shareDashboardInput slug validation', () => {
  it('rejects slugs with uppercase or spaces', () => {
    expect(shareDashboardInput.slug.safeParse('Bad Slug').success).toBe(false)
  })

  it('accepts valid lowercase-hyphenated slugs', () => {
    expect(shareDashboardInput.slug.safeParse('weekly-report').success).toBe(true)
  })
})
